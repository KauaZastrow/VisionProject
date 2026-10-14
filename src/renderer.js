"use strict";

const elements = {
  welcome: document.getElementById("welcome-section"),
  room: document.getElementById("room-section"),
  notice: document.getElementById("notice"),
  server: document.getElementById("server-url"),
  connectionDot: document.getElementById("connection-dot"),
  connectionLabel: document.getElementById("connection-label"),
  screenPicker: document.getElementById("screen-picker"),
  screenOptions: document.getElementById("screen-options"),
  screenVideo: document.getElementById("screen-video"),
  videoPlaceholder: document.getElementById("video-placeholder"),
  chatMessages: document.getElementById("chat-messages"),
};

const state = {
  socket: null,
  roomId: null,
  peerId: null,
  hostId: null,
  role: null,
  name: "",
  iceServers: [],
  localStream: null,
  remoteStream: null,
  screenDisplayId: null,
  connections: new Map(),
  pendingCandidates: new Map(),
  participants: new Map(),
  pendingControlPeerId: null,
  controllerId: null,
  controlChannel: null,
  lastPointerSent: 0,
  controlInputErrorShown: false,
};

function showNotice(message, success = false) {
  const notice = state.roomId
    ? document.getElementById("room-notice")
    : elements.notice;
  notice.textContent = message;
  notice.classList.toggle("success", success);
  notice.hidden = false;
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
  const roomNotice = document.getElementById("room-notice");
  roomNotice.hidden = true;
  roomNotice.textContent = "";
}

function setConnection(connected, label) {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionLabel.textContent = label;
}

function validateServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("O endereco do servidor deve comecar com ws:// ou wss://.");
  }
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol === "ws:" && !isLocalhost) {
    throw new Error("Por seguranca, conexoes pela internet precisam usar wss:// (TLS).");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("O endereco do servidor nao pode conter usuario, senha ou fragmento.");
  }
  return url.toString();
}

function connectSocket(message) {
  clearNotice();
  let url;
  try {
    url = validateServerUrl(elements.server.value.trim());
  } catch (error) {
    showNotice(error.message);
    return;
  }
  setConnection(false, "Conectando...");
  const socket = new WebSocket(url);
  state.socket = socket;
  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    setConnection(true, "Conectado ao servidor");
    socket.send(JSON.stringify(message));
  });
  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      showNotice("O servidor enviou uma resposta invalida.");
      return;
    }
    handleServerMessage(payload).catch((error) => {
      console.error("Falha ao processar mensagem:", error);
      showNotice(`Falha na conexao: ${error.message}`);
    });
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket) showNotice("Nao foi possivel conectar ao servidor. Verifique o endereco e se ele esta online.");
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    setConnection(false, "Desconectado");
    if (state.roomId) resetRoom("A conexao com o servidor foi encerrada.");
  });
}

function sendMessage(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function enterRoom(message, role, name) {
  state.role = role;
  state.name = name.trim().slice(0, 32);
  connectSocket(message);
}

document.getElementById("create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("create-name").value.trim();
  const password = document.getElementById("create-password").value;
  if (password.length < 8) {
    showNotice("A senha da sala precisa ter pelo menos 8 caracteres.");
    return;
  }
  enterRoom({ type: "create_room", name, password }, "host", name);
});

document.getElementById("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("join-name").value.trim();
  const roomId = document.getElementById("join-code").value.trim().toUpperCase();
  const password = document.getElementById("join-password").value;
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomId)) {
    showNotice("O codigo da sala deve ter 6 letras ou numeros.");
    return;
  }
  enterRoom({ type: "join_room", roomId, password, name }, "guest", name);
});

async function handleServerMessage(message) {
  switch (message.type) {
    case "error":
      showNotice(message.message || "O servidor recusou a solicitacao.");
      if (["ROOM_NOT_FOUND", "BAD_PASSWORD", "INVALID_INPUT", "ROOM_FULL"].includes(message.code)) {
        if (!state.roomId) {
          state.socket?.close();
          state.socket = null;
          setConnection(false, "Desconectado");
        }
      }
      break;
    case "room_created":
      if (state.role !== "host") return;
      state.roomId = message.roomId;
      state.peerId = message.peerId;
      state.iceServers = message.iceServers || [];
      showRoom();
      addSystemMessage(`Sala criada. Compartilhe o codigo ${state.roomId} e a senha com seus convidados.`);
      break;
    case "room_joined":
      if (state.role !== "guest") return;
      state.roomId = message.roomId;
      state.peerId = message.peerId;
      state.hostId = message.hostId;
      state.iceServers = message.iceServers || [];
      state.participants.set(message.hostId, message.hostName);
      showRoom();
      updateParticipants();
      addSystemMessage(`Voce entrou na sala de ${message.hostName}.`);
      await createGuestConnection(message.hostId);
      break;
    case "peer_joined":
      if (state.role !== "host") return;
      state.participants.set(message.peerId, message.name);
      updateParticipants();
      addSystemMessage(`${message.name} entrou na sala.`);
      await createHostConnection(message.peerId);
      break;
    case "peer_left":
      state.participants.delete(message.peerId);
      closePeer(message.peerId);
      if (state.controllerId === message.peerId) {
        state.controllerId = null;
        await window.telaJunta.authorizeControl(null);
        updateControlButtons();
      }
      updateParticipants();
      addSystemMessage("Um participante saiu da sala.");
      break;
    case "signal":
      await handleSignal(message.from, message.payload);
      break;
    case "chat":
      addChatMessage(message.name, message.text, message.timestamp);
      break;
    case "control_request":
      if (state.role !== "host" || state.controllerId || state.pendingControlPeerId) return;
      state.pendingControlPeerId = message.peerId;
      document.getElementById("control-requester").textContent = `${message.name} solicita controlar seu computador`;
      document.getElementById("control-prompt").hidden = false;
      break;
    case "control_response":
      if (state.role !== "guest") return;
      state.controllerId = message.approved ? state.peerId : null;
      document.getElementById("request-control").disabled = Boolean(state.controllerId);
      document.getElementById("request-control").textContent = message.revoked ? "Solicitar controle" : message.approved ? "Controle autorizado" : "Solicitar controle";
      elements.screenVideo.classList.toggle("controllable", Boolean(state.controllerId));
      if (message.revoked || !message.approved) closeControlChannel();
      else elements.screenVideo.focus();
      showNotice(
        message.approved
          ? "O anfitriao autorizou o controle. Clique na tela e use o teclado para interagir."
          : message.revoked
            ? "O anfitriao revogou sua permissao de controle."
            : "O anfitriao recusou ou encerrou a solicitacao de controle.",
        Boolean(message.approved),
      );
      break;
    case "room_closed":
      resetRoom("O anfitriao encerrou a sala.");
      break;
    case "input":
      break;
    default:
      console.warn("Mensagem do servidor ignorada:", message.type);
  }
}

function showRoom() {
  elements.welcome.hidden = true;
  elements.room.hidden = false;
  document.getElementById("room-heading").textContent = `Sala ${state.roomId}`;
  document.getElementById("room-description").textContent =
    state.role === "host"
      ? "Compartilhe o codigo e a senha para convidar participantes."
      : `Voce esta na sala de ${state.participants.get(state.hostId) || "seu anfitriao"}.`;
  document.getElementById("share-screen").hidden = state.role !== "host";
  document.getElementById("request-control").hidden = state.role !== "guest";
  document.getElementById("revoke-control").hidden = state.role !== "host";
  document.getElementById("placeholder-title").textContent =
    state.role === "host" ? "Sua sala esta pronta" : "Aguardando compartilhamento";
  document.getElementById("placeholder-copy").textContent =
    state.role === "host"
      ? "Escolha uma tela para compartilhar com seus convidados."
      : "A tela aparecera aqui quando o anfitriao comecar a compartilhar.";
  updateParticipants();
}

function addSystemMessage(text) {
  addChatMessage("TelaJunta", text, Date.now());
}

function addChatMessage(name, text, timestamp) {
  const article = document.createElement("article");
  article.className = "chat-message";
  const header = document.createElement("div");
  header.className = "chat-message-header";
  const author = document.createElement("strong");
  author.textContent = name;
  const time = document.createElement("time");
  time.textContent = new Date(timestamp || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const body = document.createElement("p");
  body.textContent = text;
  header.append(author, time);
  article.append(header, body);
  elements.chatMessages.append(article);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function updateParticipants() {
  const count = Math.max(1, state.participants.size + (state.role === "host" ? 1 : 0));
  document.getElementById("participant-count").textContent =
    `${count} participante${count === 1 ? "" : "s"}`;
}

document.getElementById("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!sendMessage({ type: "chat", text })) {
    showNotice("Nao foi possivel enviar a mensagem: desconectado do servidor.");
    return;
  }
  input.value = "";
});

async function openScreenPicker() {
  try {
    const sources = await window.telaJunta.listScreens();
    elements.screenOptions.replaceChildren();
    if (!sources.length) {
      showNotice("Nenhuma tela ou janela disponivel para compartilhar.");
      return;
    }
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "screen-option";
      button.type = "button";
      const thumbnail = document.createElement("img");
      thumbnail.src = source.thumbnail;
      thumbnail.alt = "";
      const label = document.createElement("span");
      label.textContent = source.name;
      button.append(thumbnail, label);
      button.addEventListener("click", () => startScreenShare(source.id, source.displayId));
      elements.screenOptions.append(button);
    }
    elements.screenPicker.showModal();
  } catch (error) {
    showNotice(`Nao foi possivel listar as telas: ${error.message}`);
  }
}

document.getElementById("share-screen").addEventListener("click", openScreenPicker);
document.getElementById("close-picker").addEventListener("click", () => elements.screenPicker.close());
elements.screenPicker.addEventListener("click", (event) => {
  if (event.target === elements.screenPicker) elements.screenPicker.close();
});

async function startScreenShare(sourceId, displayId) {
  elements.screenPicker.close();
  try {
    await window.telaJunta.selectScreen(sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });
    if (!state.roomId || state.role !== "host") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let audioSource = stream.getAudioTracks().length ? "system" : "none";
    let audioError = "";
    if (
      audioSource === "none" &&
      document.getElementById("audio-fallback").checked
    ) {
      try {
        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        for (const track of microphone.getAudioTracks()) {
          stream.addTrack(track);
        }
        audioSource = microphone.getAudioTracks().length ? "microphone" : "none";
      } catch (error) {
        audioError = error.message;
      }
    }
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.localStream = stream;
    state.screenDisplayId = displayId || "0";
    elements.screenVideo.srcObject = stream;
    elements.screenVideo.muted = true;
    elements.videoPlaceholder.hidden = true;
    document.getElementById("screen-status").textContent =
      audioSource === "system"
        ? "Compartilhando tela e audio do sistema"
        : audioSource === "microphone"
          ? "Compartilhando tela e audio do microfone"
          : audioError
            ? "Tela compartilhada sem audio: permissao do microfone negada"
            : "Tela compartilhada; audio indisponivel";
    if (audioError) {
      showNotice(`O microfone nao pode ser compartilhado; a tela continuara sem audio: ${audioError}`);
    }
    document.getElementById("screen-label").textContent = "Sua tela compartilhada";
    document.getElementById("live-dot").classList.add("active");
    document.getElementById("share-screen").textContent = "Trocar tela";
    stream.getVideoTracks()[0]?.addEventListener("ended", stopScreenShare, { once: true });
    for (const [peerId, connection] of state.connections) {
      await addLocalTracks(connection);
      await makeOffer(connection, peerId);
    }
  } catch (error) {
    await window.telaJunta.selectScreen("").catch(() => {});
    showNotice(`O compartilhamento foi cancelado ou falhou: ${error.message}`);
  }
}

function stopScreenShare() {
  if (!state.localStream) return;
  state.localStream.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  elements.screenVideo.srcObject = null;
  elements.videoPlaceholder.hidden = false;
  document.getElementById("live-dot").classList.remove("active");
  document.getElementById("screen-label").textContent = "Tela compartilhada";
  document.getElementById("screen-status").textContent = "Nenhuma tela compartilhada";
  document.getElementById("share-screen").textContent = "Compartilhar tela";
}

function makePeerConnection(peerId) {
  const connection = new RTCPeerConnection({ iceServers: state.iceServers });
  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({
        type: "signal",
        target: peerId,
        payload: { candidate: event.candidate },
      });
    }
  });
  connection.addEventListener("connectionstatechange", () => {
    if (["failed", "closed"].includes(connection.connectionState)) closePeer(peerId);
  });
  state.connections.set(peerId, connection);
  return connection;
}

async function addLocalTracks(connection) {
  if (!state.localStream) return;
  for (const track of state.localStream.getTracks()) {
    const sender = connection.getSenders().find((candidate) => candidate.track?.kind === track.kind);
    if (sender) {
      await sender.replaceTrack(track);
    } else {
      connection.addTrack(track, state.localStream);
    }
  }
}

async function createHostConnection(peerId) {
  const connection = makePeerConnection(peerId);
  const channel = connection.createDataChannel("remote-input", { ordered: true });
  channel.addEventListener("message", (dataEvent) => {
    if (state.controllerId !== peerId) return;
    try {
      const input = JSON.parse(dataEvent.data);
      window.telaJunta.sendControlInput(peerId, input).catch((error) => {
        console.error("Falha ao encaminhar controle remoto:", error);
        if (!state.controlInputErrorShown) {
          state.controlInputErrorShown = true;
          showNotice(`Falha ao executar o controle remoto: ${error.message}`);
        }
      });
    } catch (error) {
      console.warn("Evento de controle remoto ignorado:", error);
    }
  });
  await addLocalTracks(connection);
  if (state.localStream) await makeOffer(connection, peerId);
}

async function createGuestConnection(peerId) {
  const connection = makePeerConnection(peerId);
  connection.addEventListener("track", (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    state.remoteStream = stream;
    elements.screenVideo.srcObject = stream;
    elements.screenVideo.muted = false;
    elements.videoPlaceholder.hidden = true;
    document.getElementById("live-dot").classList.add("active");
    document.getElementById("screen-status").textContent = "Recebendo compartilhamento em tempo real";
    elements.screenVideo.play().catch(() => {
      document.getElementById("screen-status").textContent =
        "Clique na tela para ativar a reproducao de video e audio.";
    });
  });
  connection.addEventListener("datachannel", (event) => {
    if (event.channel.label === "remote-input") {
      state.controlChannel = event.channel;
      event.channel.addEventListener("close", closeControlChannel);
    }
  });
}

async function makeOffer(connection, peerId) {
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  sendMessage({
    type: "signal",
    target: peerId,
    payload: { description: connection.localDescription },
  });
}

async function handleSignal(peerId, payload) {
  let connection = state.connections.get(peerId);
  if (!connection && state.role === "host") {
    connection = await createHostConnection(peerId);
  } else if (!connection && state.role === "guest") {
    connection = await createGuestConnection(peerId);
  }
  if (!connection) return;

  if (payload.description) {
    const description = payload.description;
    await connection.setRemoteDescription(new RTCSessionDescription(description));
    const candidates = state.pendingCandidates.get(peerId) || [];
    state.pendingCandidates.delete(peerId);
    for (const candidate of candidates) {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    if (description.type === "offer") {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      sendMessage({
        type: "signal",
        target: peerId,
        payload: { description: connection.localDescription },
      });
    }
  } else if (payload.candidate) {
    if (!connection.remoteDescription) {
      const candidates = state.pendingCandidates.get(peerId) || [];
      candidates.push(payload.candidate);
      state.pendingCandidates.set(peerId, candidates);
    } else {
      await connection.addIceCandidate(new RTCIceCandidate(payload.candidate));
    }
  }
}

function closePeer(peerId) {
  const connection = state.connections.get(peerId);
  if (connection && connection.connectionState !== "closed") connection.close();
  state.connections.delete(peerId);
  state.pendingCandidates.delete(peerId);
  if (state.role === "host" && state.controllerId === peerId) {
    state.controllerId = null;
    window.telaJunta.authorizeControl(null).catch(console.error);
    updateControlButtons();
  }
}

document.getElementById("request-control").addEventListener("click", () => {
  if (!sendMessage({ type: "control_request" })) {
    showNotice("Nao foi possivel solicitar controle: desconectado do servidor.");
    return;
  }
  document.getElementById("request-control").disabled = true;
  document.getElementById("request-control").textContent = "Aguardando aprovacao...";
  showNotice("Solicitacao enviada. O anfitriao precisa autorizar o controle.");
});

async function respondToControl(approved) {
  const target = state.pendingControlPeerId;
  if (!target) return;
  if (approved) {
    state.controllerId = target;
    state.controlInputErrorShown = false;
    await window.telaJunta.authorizeControl(target);
  }
  sendMessage({ type: "control_response", target, approved });
  state.pendingControlPeerId = null;
  document.getElementById("control-prompt").hidden = true;
  document.getElementById("room-notice").hidden = true;
  document.getElementById("screen-status").textContent = approved
    ? `Controle remoto autorizado para ${state.participants.get(target) || "participante"}`
    : "Solicitacao de controle recusada";
  updateControlButtons();
}

document.getElementById("approve-control").addEventListener("click", () => {
  respondToControl(true).catch((error) => showNotice(`Nao foi possivel autorizar o controle: ${error.message}`));
});
document.getElementById("reject-control").addEventListener("click", () => {
  respondToControl(false).catch((error) => showNotice(`Nao foi possivel recusar o controle: ${error.message}`));
});
document.getElementById("revoke-control").addEventListener("click", async () => {
  sendMessage({ type: "control_revoked" });
  state.controllerId = null;
  state.pendingControlPeerId = null;
  document.getElementById("control-prompt").hidden = true;
  await window.telaJunta.authorizeControl(null);
  updateControlButtons();
  document.getElementById("screen-status").textContent = "Permissao de controle revogada";
});

function updateControlButtons() {
  document.getElementById("revoke-control").textContent = state.controllerId
    ? "Revogar controle"
    : "Controle inativo";
  document.getElementById("revoke-control").disabled = !state.controllerId;
}

function closeControlChannel() {
  state.controlChannel?.close();
  state.controlChannel = null;
  state.controllerId = null;
  document.getElementById("request-control").disabled = false;
  document.getElementById("request-control").textContent = "Solicitar controle";
  elements.screenVideo.classList.remove("controllable");
}

function sendRemoteInput(input) {
  if (
    state.role !== "guest" ||
    !state.controllerId ||
    state.controlChannel?.readyState !== "open"
  ) {
    return;
  }
  state.controlChannel.send(JSON.stringify(input));
}

elements.screenVideo.addEventListener("pointermove", (event) => {
  if (!state.controllerId) return;
  const now = performance.now();
  if (now - state.lastPointerSent < 33) return;
  state.lastPointerSent = now;
  const rect = elements.screenVideo.getBoundingClientRect();
  const videoRatio = elements.screenVideo.videoWidth / elements.screenVideo.videoHeight;
  if (!videoRatio) return;
  const boxRatio = rect.width / rect.height;
  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (boxRatio > videoRatio) {
    contentWidth = rect.height * videoRatio;
    offsetX = (rect.width - contentWidth) / 2;
  } else {
    contentHeight = rect.width / videoRatio;
    offsetY = (rect.height - contentHeight) / 2;
  }
  const x = (event.clientX - rect.left - offsetX) / contentWidth;
  const y = (event.clientY - rect.top - offsetY) / contentHeight;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    sendRemoteInput({ type: "move", x, y, displayId: state.screenDisplayId });
  }
});

elements.screenVideo.addEventListener("pointerdown", (event) => {
  if (!state.controllerId || event.button > 2) return;
  elements.screenVideo.focus();
  event.preventDefault();
  sendRemoteInput({
    type: "button",
    button: ["left", "middle", "right"][event.button],
    action: "down",
  });
});
elements.screenVideo.addEventListener("pointerup", (event) => {
  if (!state.controllerId || event.button > 2) return;
  event.preventDefault();
  sendRemoteInput({
    type: "button",
    button: ["left", "middle", "right"][event.button],
    action: "up",
  });
});
elements.screenVideo.addEventListener("wheel", (event) => {
  if (!state.controllerId) return;
  event.preventDefault();
  sendRemoteInput({
    type: "wheel",
    x: Math.sign(event.deltaX) * Math.min(10, Math.ceil(Math.abs(event.deltaX) / 100)),
    y: Math.sign(event.deltaY) * Math.min(10, Math.ceil(Math.abs(event.deltaY) / 100)),
  });
}, { passive: false });
elements.screenVideo.addEventListener("contextmenu", (event) => {
  if (state.controllerId) event.preventDefault();
});
document.addEventListener("keydown", (event) => {
  if (!state.controllerId || document.activeElement !== elements.screenVideo) return;
  event.preventDefault();
  sendRemoteInput({ code: event.code, action: "down" });
});
document.addEventListener("keyup", (event) => {
  if (!state.controllerId || document.activeElement !== elements.screenVideo) return;
  event.preventDefault();
  sendRemoteInput({ code: event.code, action: "up" });
});

document.getElementById("leave-room").addEventListener("click", () => {
  state.socket?.close();
  state.socket = null;
  resetRoom("Voce saiu da sala.");
});

function resetRoom(message) {
  stopScreenShare();
  for (const peerId of state.connections.keys()) closePeer(peerId);
  state.connections.clear();
  state.pendingCandidates.clear();
  state.participants.clear();
  closeControlChannel();
  state.roomId = null;
  state.peerId = null;
  state.hostId = null;
  state.role = null;
  state.iceServers = [];
  state.screenDisplayId = null;
  state.pendingControlPeerId = null;
  state.controllerId = null;
  elements.chatMessages.replaceChildren();
  elements.room.hidden = true;
  elements.welcome.hidden = false;
  document.getElementById("control-prompt").hidden = true;
  document.getElementById("request-control").disabled = false;
  setConnection(false, "Desconectado");
  if (message) showNotice(message);
}
