import hmac
import ipaddress
import json
import queue
import secrets
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

LAN_CLIENT_NETWORKS = tuple(ipaddress.ip_network(network) for network in (
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "100.64.0.0/10",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
))


class Room:
    def __init__(self, password):
        self.room_id = secrets.token_hex(5).upper()
        self.password = password
        self.host_token = secrets.token_urlsafe(32)
        self.host_events = queue.Queue()
        self.viewer_events = queue.Queue()
        self.viewer_id = None
        self.viewer_token = None
        self.viewer_approved = False
        self.closed = False


class RoomRegistry:
    def __init__(self):
        self._rooms = {}
        self._lock = threading.RLock()

    def create(self, password):
        with self._lock:
            room = Room(password)
            while room.room_id in self._rooms:
                room.room_id = secrets.token_hex(5).upper()
            self._rooms[room.room_id] = room
            return {"roomId": room.room_id, "token": room.host_token}

    def join(self, room_id, password):
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None or room.closed:
                raise ValueError("Sala não encontrada ou encerrada.")
            if not hmac.compare_digest(room.password.encode("utf-8"), password.encode("utf-8")):
                raise PermissionError("Senha incorreta.")
            if room.viewer_id is not None:
                raise ValueError("Esta sala já tem uma solicitação ou participante.")

            room.viewer_id = secrets.token_hex(8)
            room.viewer_token = secrets.token_urlsafe(32)
            room.viewer_approved = False
            room.viewer_events = queue.Queue()
            room.host_events.put({"type": "join-request", "viewerId": room.viewer_id})
            return {"roomId": room.room_id, "peerId": room.viewer_id, "token": room.viewer_token}

    def decide(self, room_id, token, viewer_id, accepted):
        with self._lock:
            room = self._get_room(room_id)
            if not hmac.compare_digest(room.host_token, token):
                raise PermissionError("Sessão inválida.")
            if room.viewer_id != viewer_id:
                raise ValueError("A solicitação não está mais ativa.")
            room.viewer_approved = accepted
            room.viewer_events.put({"type": "approved" if accepted else "denied"})

    def signal(self, room_id, peer_id, token, message):
        with self._lock:
            room = self._get_room(room_id)
            if peer_id == "host":
                if not hmac.compare_digest(room.host_token, token):
                    raise PermissionError("Sessão inválida.")
                if not room.viewer_approved:
                    raise PermissionError("O participante ainda não foi aprovado.")
                destination = room.viewer_events
                sender = "host"
            elif peer_id == room.viewer_id:
                if not hmac.compare_digest(room.viewer_token or "", token):
                    raise PermissionError("Sessão inválida.")
                if not room.viewer_approved:
                    raise PermissionError("O dono ainda não aprovou a solicitação.")
                destination = room.host_events
                sender = "viewer"
            else:
                raise PermissionError("Participante inválido.")
            destination.put({"type": "signal", "from": sender, "message": message})

    def leave(self, room_id, peer_id, token):
        with self._lock:
            room = self._get_room(room_id)
            if peer_id == "host":
                if not hmac.compare_digest(room.host_token, token):
                    raise PermissionError("Sessão inválida.")
                room.closed = True
                if room.viewer_id is not None:
                    room.viewer_events.put({"type": "ended"})
            elif peer_id == room.viewer_id:
                if not hmac.compare_digest(room.viewer_token or "", token):
                    raise PermissionError("Sessão inválida.")
                room.host_events.put({"type": "viewer-left"})
                room.viewer_id = None
                room.viewer_token = None
                room.viewer_approved = False
            else:
                raise PermissionError("Participante inválido.")

    def poll(self, room_id, peer_id, token):
        with self._lock:
            room = self._get_room(room_id)
            if peer_id == "host" and hmac.compare_digest(room.host_token, token):
                events = room.host_events
            elif peer_id == room.viewer_id and hmac.compare_digest(room.viewer_token or "", token):
                events = room.viewer_events
            else:
                raise PermissionError("Sessão inválida.")
        try:
            first = events.get(timeout=15)
        except queue.Empty:
            return []
        result = [first]
        while len(result) < 20:
            try:
                result.append(events.get_nowait())
            except queue.Empty:
                break
        return result

    def _get_room(self, room_id):
        room = self._rooms.get(room_id)
        if room is None:
            raise ValueError("Sala não encontrada.")
        return room


class YVisionHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, app_directory):
        self.registry = RoomRegistry()
        self.app_directory = Path(app_directory).resolve()
        super().__init__(("0.0.0.0", 0), partial(YVisionRequestHandler, directory=str(self.app_directory)))
        self.lan_address = get_lan_address()


class YVisionRequestHandler(SimpleHTTPRequestHandler):
    server_version = "Y-Vision"

    def log_message(self, format, *args):
        return

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def do_OPTIONS(self):
        if not self._is_lan_client():
            self.send_error(403)
            return
        if urlsplit(self.path).path.startswith("/api/"):
            self.send_response(204)
            self._cors_headers()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        if not self._is_lan_client():
            self.send_error(403)
            return
        path = urlsplit(self.path).path
        if path == "/api/info":
            self._send_json(200, {
                "lanUrl": f"http://{self.server.lan_address}:{self.server.server_port}",
                "port": self.server.server_port,
            })
        elif path == "/api/events":
            query = parse_qs(urlsplit(self.path).query)
            try:
                events = self.server.registry.poll(
                    query.get("roomId", [""])[0],
                    query.get("peerId", [""])[0],
                    query.get("token", [""])[0],
                )
                self._send_json(200, {"events": events})
            except PermissionError as error:
                self._send_json(403, {"error": str(error)})
            except ValueError as error:
                self._send_json(404, {"error": str(error)})
        elif path in ("/", "/index.html", "/styles.css", "/app.js"):
            self.path = "/index.html" if path == "/" else path
            super().do_GET()
        else:
            self.send_error(404)

    def do_POST(self):
        if not self._is_lan_client():
            self.send_error(403)
            return
        path = urlsplit(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/rooms":
                password = payload.get("password", "")
                if not isinstance(password, str) or len(password) > 64:
                    self._send_json(400, {"error": "Senha inválida."})
                    return
                self._send_json(201, self.server.registry.create(password))
            elif path == "/api/rooms/join":
                room_id = str(payload.get("roomId", "")).strip().upper()
                password = payload.get("password", "")
                if not isinstance(password, str):
                    self._send_json(400, {"error": "Senha inválida."})
                    return
                self._send_json(200, self.server.registry.join(room_id, password))
            elif path == "/api/rooms/decision":
                self.server.registry.decide(
                    str(payload.get("roomId", "")),
                    str(payload.get("token", "")),
                    str(payload.get("viewerId", "")),
                    payload.get("accepted") is True,
                )
                self._send_json(200, {"ok": True})
            elif path == "/api/signal":
                message = payload.get("message")
                if not isinstance(message, dict):
                    self._send_json(400, {"error": "Mensagem inválida."})
                    return
                self.server.registry.signal(
                    str(payload.get("roomId", "")),
                    str(payload.get("peerId", "")),
                    str(payload.get("token", "")),
                    message,
                )
                self._send_json(202, {"ok": True})
            elif path == "/api/rooms/leave":
                self.server.registry.leave(
                    str(payload.get("roomId", "")),
                    str(payload.get("peerId", "")),
                    str(payload.get("token", "")),
                )
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"error": "Endpoint não encontrado."})
        except PermissionError as error:
            self._send_json(403, {"error": str(error)})
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            self._send_json(400, {"error": f"JSON inválido: {error}"})
        except ValueError as error:
            self._send_json(400, {"error": str(error)})

    def _read_json(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Tamanho de conteúdo inválido.") from error
        if content_length <= 0 or content_length > 16_384:
            raise ValueError("Tamanho de requisição inválido.")
        value = json.loads(self.rfile.read(content_length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("O corpo precisa ser um objeto JSON.")
        return value

    def _is_lan_client(self):
        try:
            address = ipaddress.ip_address(self.client_address[0])
            if getattr(address, "ipv4_mapped", None):
                address = address.ipv4_mapped
            return any(address in network for network in LAN_CLIENT_NETWORKS if network.version == address.version)
        except ValueError:
            return False

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        if urlsplit(origin).hostname in ("localhost", "127.0.0.1", "::1"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")


def get_lan_address():
    connection = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        connection.connect(("192.0.2.1", 80))
        return connection.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        connection.close()


def create_server(app_directory):
    return YVisionHTTPServer(app_directory)