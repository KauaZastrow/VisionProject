const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_GUESTS = 8;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.TELAJUNTA_ALLOWED_ORIGINS || "file://,null")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const rooms = new Map();
const connections = new Map();
const authenticating = new Set();

function loadIceServers() {
  const configured = process.env.TELAJUNTA_ICE_SERVERS;
  if (!configured) {
    return [{ urls: ["stun:stun.l.google.com:19302"] }];
  }
  const servers = JSON.parse(configured);
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error("TELAJUNTA_ICE_SERVERS deve ser um array JSON nao vazio.");
  }
  return servers;
}

const iceServers = loadIceServers();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket, code, message) {
  send(socket, { type: "error", code, message });
}

function cleanName(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32)
    : "";
}

function cleanRoomId(value) {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(value)
    ? value
    : "";
}

function passwordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function verifyPassword(password, salt, expected) {
  const actual = await passwordHash(password, salt);
  return crypto.timingSafeEqual(actual, expected);
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
  } while (rooms.has(id));
  return id;
}

function sendToPeer(room, peerId, message) {
  const peer = room.peers.get(peerId);
  if (peer) send(peer.socket, message);
}

function removePeer(socket) {
  authenticating.delete(socket);
  const peer = connections.get(socket);
  if (!peer) return;
  connections.delete(socket);
  const room = rooms.get(peer.roomId);
  if (!room) return;

  if (peer.role === "host") {
    for (const member of room.peers.values()) {
      if (member !== peer) send(member.socket, { type: "room_closed" });
    }
    rooms.delete(peer.roomId);
    return;
  }

  room.peers.delete(peer.id);
  if (room.controllerId === peer.id) room.controllerId = null;
  sendToPeer(room, room.hostId, { type: "peer_left", peerId: peer.id });
  for (const member of room.peers.values()) {
    if (member !== peer) send(member.socket, { type: "peer_left", peerId: peer.id });
  }
}

async function handleMessage(socket, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    sendError(socket, "INVALID_MESSAGE", "Mensagem JSON invalida.");
    return;
  }
  if (!message || typeof message.type !== "string") {
    sendError(socket, "INVALID_MESSAGE", "Formato de mensagem invalido.");
    return;
  }

  if (message.type === "create_room") {
    if (connections.has(socket) || authenticating.has(socket)) return;
    const name = cleanName(message.name);
    const password = message.password;
    if (!name || typeof password !== "string" || password.length < 8 || password.length > 128) {
      sendError(socket, "INVALID_INPUT", "Informe um nome e uma senha de 8 a 128 caracteres.");
      return;
    }
    const roomId = makeRoomId();
    const salt = crypto.randomBytes(16);
    authenticating.add(socket);
    const hash = await passwordHash(password, salt);
    if (socket.readyState !== WebSocket.OPEN) {
      authenticating.delete(socket);
      return;
    }
    const host = { id: crypto.randomUUID(), name, role: "host", socket, roomId };
    const room = {
      id: roomId,
      salt,
      hash,
      hostId: host.id,
      controllerId: null,
      pendingJoins: 0,
      peers: new Map([[host.id, host]]),
    };
    rooms.set(roomId, room);
    connections.set(socket, host);
    send(socket, { type: "room_created", roomId, peerId: host.id, iceServers });
    return;
  }

  if (message.type === "join_room") {
    if (connections.has(socket) || authenticating.has(socket)) return;
    const roomId = cleanRoomId(message.roomId);
    const room = rooms.get(roomId);
    if (!room) {
      sendError(socket, "ROOM_NOT_FOUND", "Sala nao encontrada ou encerrada.");
      return;
    }
    const password = message.password;
    if (typeof password !== "string" || password.length > 128) {
      sendError(socket, "INVALID_INPUT", "Senha invalida.");
      return;
    }
    if (room.peers.size - 1 + room.pendingJoins >= MAX_GUESTS) {
      sendError(socket, "ROOM_FULL", "A sala atingiu o limite de participantes.");
      return;
    }
    room.pendingJoins += 1;
    authenticating.add(socket);
    let validPassword;
    try {
      validPassword = await verifyPassword(password, room.salt, room.hash);
    } finally {
      room.pendingJoins -= 1;
      authenticating.delete(socket);
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!validPassword) {
      sendError(socket, "BAD_PASSWORD", "Codigo ou senha incorretos.");
      return;
    }
    if (rooms.get(roomId) !== room) {
      sendError(socket, "ROOM_CLOSED", "A sala foi encerrada.");
      return;
    }
    if (room.peers.size - 1 >= MAX_GUESTS) {
      sendError(socket, "ROOM_FULL", "A sala atingiu o limite de participantes.");
      return;
    }
    const guest = {
      id: crypto.randomUUID(),
      name: cleanName(message.name) || "Convidado",
      role: "guest",
      socket,
      roomId,
    };
    room.peers.set(guest.id, guest);
    connections.set(socket, guest);
    send(socket, {
      type: "room_joined",
      roomId,
      peerId: guest.id,
      hostId: room.hostId,
      hostName: room.peers.get(room.hostId).name,
      iceServers,
    });
    sendToPeer(room, room.hostId, {
      type: "peer_joined",
      peerId: guest.id,
      name: guest.name,
    });
    return;
  }

  const peer = connections.get(socket);
  if (!peer) {
    sendError(socket, "UNAUTHENTICATED", "Conecte-se a uma sala primeiro.");
    return;
  }
  const room = rooms.get(peer.roomId);
  if (!room) {
    sendError(socket, "ROOM_CLOSED", "A sala foi encerrada.");
    return;
  }

  switch (message.type) {
    case "signal": {
      if (
        typeof message.target !== "string" ||
        !room.peers.has(message.target) ||
        !message.payload ||
        typeof message.payload !== "object" ||
        Array.isArray(message.payload)
      ) {
        sendError(socket, "INVALID_SIGNAL", "Sinal WebRTC invalido.");
        return;
      }
      sendToPeer(room, message.target, {
        type: "signal",
        from: peer.id,
        payload: message.payload,
      });
      break;
    }
    case "chat": {
      if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 2000) {
        sendError(socket, "INVALID_INPUT", "A mensagem deve ter entre 1 e 2000 caracteres.");
        return;
      }
      for (const member of room.peers.values()) {
        send(member.socket, {
          type: "chat",
          peerId: peer.id,
          name: peer.name,
          text: message.text.trim(),
          timestamp: Date.now(),
        });
      }
      break;
    }
    case "control_request":
      if (peer.role !== "guest" || room.controllerId) {
        sendError(socket, "CONTROL_UNAVAILABLE", "O controle remoto nao esta disponivel.");
        return;
      }
      sendToPeer(room, room.hostId, {
        type: "control_request",
        peerId: peer.id,
        name: peer.name,
      });
      break;
    case "control_response": {
      if (peer.role !== "host" || typeof message.target !== "string") {
        sendError(socket, "UNAUTHORIZED", "Somente quem compartilha a tela pode aprovar o controle.");
        return;
      }
      const target = room.peers.get(message.target);
      if (!target || target.role !== "guest") return;
      const approved = message.approved === true;
      if (approved && room.controllerId && room.controllerId !== target.id) {
        sendError(socket, "CONTROL_UNAVAILABLE", "Outro participante ja esta no controle.");
        return;
      }
      if (approved) room.controllerId = target.id;
      send(target.socket, { type: "control_response", approved });
      break;
    }
    case "control_revoked":
      if (peer.role !== "host") {
        sendError(socket, "UNAUTHORIZED", "Somente quem compartilha a tela pode revogar o controle.");
        return;
      }
      room.controllerId = null;
      for (const member of room.peers.values()) {
        if (member.role === "guest") {
          send(member.socket, { type: "control_response", approved: false, revoked: true });
        }
      }
      break;
    case "input":
      if (peer.role !== "guest" || room.controllerId !== peer.id) {
        sendError(socket, "UNAUTHORIZED", "Controle remoto nao autorizado.");
        return;
      }
      sendToPeer(room, room.hostId, { type: "input", peerId: peer.id, input: message.input });
      break;
    default:
      sendError(socket, "UNKNOWN_MESSAGE", "Tipo de mensagem desconhecido.");
  }
}

function startServer({
  host = HOST,
  port = PORT,
  quiet = false,
  tlsKeyFile = process.env.TLS_KEY_FILE,
  tlsCertFile = process.env.TLS_CERT_FILE,
} = {}) {
  let server;
  if (tlsKeyFile || tlsCertFile) {
    if (!tlsKeyFile || !tlsCertFile) {
      throw new Error("Configure TLS_KEY_FILE e TLS_CERT_FILE juntos.");
    }
    server = https.createServer({
      key: fs.readFileSync(tlsKeyFile),
      cert: fs.readFileSync(tlsCertFile),
    });
  } else {
    server = http.createServer();
  }

  const websocketServer = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ origin }, callback) => {
      callback(
        !origin || ALLOWED_ORIGINS.has(origin),
        origin && !ALLOWED_ORIGINS.has(origin) ? 403 : undefined,
        origin && !ALLOWED_ORIGINS.has(origin) ? "Origin not allowed" : undefined,
      );
    },
  });

  websocketServer.on("connection", (socket) => {
    const now = Date.now();
    const rate = { startedAt: now, count: 0 };
    socket.on("message", (data) => {
      if (Date.now() - rate.startedAt > 10_000) {
        rate.startedAt = Date.now();
        rate.count = 0;
      }
      rate.count += 1;
      if (rate.count > 120) {
        sendError(socket, "RATE_LIMITED", "Muitas mensagens; conexao encerrada.");
        socket.close(1008, "rate limit");
        return;
      }
      handleMessage(socket, data).catch((error) => {
        console.error("Erro ao processar mensagem:", error);
        sendError(socket, "SERVER_ERROR", "Erro interno ao processar a solicitacao.");
      });
    });
    socket.on("close", () => removePeer(socket));
    socket.on("error", (error) => console.error("Erro WebSocket:", error.message));
  });

  server.listen(port, host, () => {
    if (quiet) return;
    const protocol = server instanceof https.Server ? "wss" : "ws";
    console.log(`TelaJunta signaling (${protocol}) escutando em ${host}:${server.address().port}`);
    if (protocol === "ws" && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      console.warn("AVISO: WS sem TLS. Use TLS_KEY_FILE/TLS_CERT_FILE ou um proxy HTTPS antes de expor a internet.");
    }
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { startServer };
