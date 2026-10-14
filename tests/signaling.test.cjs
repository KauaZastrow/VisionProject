const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { after, test } = require("node:test");
const WebSocket = require("ws");
const { startServer } = require("../server/index.cjs");

let server;
const clients = new Set();

function waitForMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout aguardando mensagem ${type}.`));
    }, 5000);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function openClient(url) {
  const socket = new WebSocket(url);
  clients.add(socket);
  await once(socket, "open");
  return socket;
}

test("salas protegem senha e autorizacao de controle e encaminham sinalizacao/chat", async () => {
  const portProbe = net.createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((resolve, reject) =>
    portProbe.close((error) => (error ? reject(error) : resolve())),
  );

  server = startServer({ host: "127.0.0.1", port, quiet: true });
  await once(server, "listening");
  const url = `ws://127.0.0.1:${port}`;
  const rejectedOrigin = new WebSocket(url, { origin: "https://example.com" });
  rejectedOrigin.on("error", () => {});
  const deniedStatus = await new Promise((resolve) =>
    rejectedOrigin.once("unexpected-response", (_request, response) =>
      resolve(response.statusCode),
    ),
  );
  assert.equal(deniedStatus, 403);

  const host = await openClient(url);
  const created = waitForMessage(host, "room_created");
  host.send(JSON.stringify({
    type: "create_room",
    name: "Anfitria",
    password: "senha-segura-123",
  }));
  const room = await created;

  const guest = await openClient(url);
  const denied = waitForMessage(guest, "error");
  guest.send(JSON.stringify({
    type: "join_room",
    roomId: room.roomId,
    password: "senha-errada",
    name: "Convidado",
  }));
  assert.equal((await denied).code, "BAD_PASSWORD");

  const hostJoinNotice = waitForMessage(host, "peer_joined");
  const joined = waitForMessage(guest, "room_joined");
  guest.send(JSON.stringify({
    type: "join_room",
    roomId: room.roomId,
    password: "senha-segura-123",
    name: "Convidado",
  }));
  const guestRoom = await joined;
  assert.equal((await hostJoinNotice).peerId, guestRoom.peerId);

  const unauthorized = waitForMessage(guest, "error");
  guest.send(JSON.stringify({ type: "input", input: { type: "move", x: 0.5, y: 0.5 } }));
  assert.equal((await unauthorized).code, "UNAUTHORIZED");

  const controlRequest = waitForMessage(host, "control_request");
  guest.send(JSON.stringify({ type: "control_request" }));
  const requested = await controlRequest;
  const approved = waitForMessage(guest, "control_response");
  host.send(JSON.stringify({
    type: "control_response",
    target: requested.peerId,
    approved: true,
  }));
  assert.equal((await approved).approved, true);

  const remoteInput = waitForMessage(host, "input");
  guest.send(JSON.stringify({ type: "input", input: { type: "button", button: "left", action: "down" } }));
  assert.equal((await remoteInput).peerId, guestRoom.peerId);

  const forwardedSignal = waitForMessage(host, "signal");
  guest.send(JSON.stringify({
    type: "signal",
    target: guestRoom.hostId,
    payload: { description: { type: "offer", sdp: "test" } },
  }));
  assert.equal((await forwardedSignal).from, guestRoom.peerId);

  const chat = waitForMessage(guest, "chat");
  host.send(JSON.stringify({ type: "chat", text: "Ola!" }));
  assert.equal((await chat).text, "Ola!");

  const roomClosed = waitForMessage(guest, "room_closed");
  host.close();
  assert.equal((await roomClosed).type, "room_closed");
});

after(async () => {
  for (const client of clients) {
    if (client.readyState !== WebSocket.CLOSED) client.close();
  }
  if (server?.listening) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
