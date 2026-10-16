const startShareButton = document.querySelector("#start-share");
const stopShareButton = document.querySelector("#stop-share");
const preview = document.querySelector("#screen-preview");
const previewEmpty = document.querySelector("#preview-empty");
const liveIndicator = document.querySelector("#live-indicator");
const shareMessage = document.querySelector("#share-message");
const joinMessage = document.querySelector("#join-message");
const roomPassword = document.querySelector("#room-password");
const roomCodeRow = document.querySelector("#room-code-row");
const roomCode = document.querySelector("#room-code");
const requestPanel = document.querySelector("#request-panel");
const hostAddressInput = document.querySelector("#host-address");
const joinRoomIdInput = document.querySelector("#room-id");
const infoDialog = document.querySelector("#info-dialog");
const toast = document.querySelector("#toast");
let displayStream;
let roomSession;
let peerConnection;
let pendingViewerId;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4300);
}

function setNotice(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("notice-error", isError);
}

async function apiRequest(baseUrl, path, method = "GET", body, signal) {
  const options = { method, cache: "no-store", signal };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, options);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Não foi possível alcançar o servidor. Confira o endereço, a rede e o firewall do Windows.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Falha HTTP ${response.status}.`);
  return result;
}

function sessionPayload(session) {
  return { roomId: session.roomId, peerId: session.peerId, token: session.token };
}

async function sendSignal(session, message) {
  await apiRequest(session.baseUrl, "/api/signal", "POST", { ...sessionPayload(session), message });
}

function setLocalPreview(stream) {
  preview.srcObject = null;
  preview.muted = true;
  preview.controls = false;
  preview.srcObject = stream;
  preview.hidden = false;
  previewEmpty.hidden = true;
  liveIndicator.hidden = false;
}

function closePeerConnection(clearPreview = false) {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = undefined;
  }
  if (clearPreview) {
    preview.pause();
    preview.srcObject = null;
    preview.hidden = true;
    preview.controls = false;
    preview.muted = true;
    previewEmpty.hidden = false;
    liveIndicator.hidden = true;
  }
}

function createPeerConnection(session, remoteViewer) {
  closePeerConnection();
  const connection = new RTCPeerConnection({ iceServers: [] });
  peerConnection = connection;
  session.pendingCandidates = [];
  connection.onicecandidate = (event) => {
    if (event.candidate && roomSession === session) {
      sendSignal(session, { kind: "ice", candidate: event.candidate.toJSON() }).catch((error) => {
        setNotice(session.role === "host" ? shareMessage : joinMessage, error.message, true);
      });
    }
  };
  connection.ontrack = (event) => {
    if (session.role !== "viewer") return;
    preview.srcObject = event.streams[0];
    preview.muted = false;
    preview.controls = true;
    preview.hidden = false;
    previewEmpty.hidden = true;
    liveIndicator.hidden = false;
    preview.play().catch(() => {
      setNotice(joinMessage, "A conexão chegou. Clique em reproduzir para ouvir o áudio.");
    });
  };
  connection.onconnectionstatechange = () => {
    if (roomSession !== session) return;
    if (connection.connectionState === "connected") {
      setNotice(session.role === "host" ? shareMessage : joinMessage, "Conectado diretamente pela rede local.");
    } else if (["failed", "disconnected"].includes(connection.connectionState)) {
      setNotice(session.role === "host" ? shareMessage : joinMessage, "Conexão interrompida. Confira se os dois PCs estão na mesma rede e se o firewall permite WebRTC.", true);
    }
  };
  if (session.role === "host") {
    displayStream.getTracks().forEach((track) => connection.addTrack(track, displayStream));
  }
  return connection;
}

async function flushIceCandidates(session, connection) {
  const candidates = session.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await connection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function startHostConnection(session) {
  const connection = createPeerConnection(session, true);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await sendSignal(session, { kind: "description", description: connection.localDescription });
  setNotice(shareMessage, "Pedido autorizado. Estabelecendo conexão direta...");
}

async function startViewerConnection(session) {
  if (!peerConnection) createPeerConnection(session, false);
  setNotice(joinMessage, "Pedido aprovado. Aguardando a transmissão...");
}

async function handleSignal(session, message) {
  if (message.kind === "description" && session.role === "viewer") {
    const connection = peerConnection || createPeerConnection(session, false);
    await connection.setRemoteDescription(new RTCSessionDescription(message.description));
    await flushIceCandidates(session, connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendSignal(session, { kind: "description", description: connection.localDescription });
  } else if (message.kind === "description" && session.role === "host") {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(message.description));
    await flushIceCandidates(session, peerConnection);
  } else if (message.kind === "ice") {
    if (!peerConnection || !peerConnection.remoteDescription) {
      session.pendingCandidates.push(message.candidate);
    } else {
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    }
  }
}

async function handleHostEvent(session, event) {
  if (event.type === "join-request") {
    pendingViewerId = event.viewerId;
    requestPanel.hidden = false;
    setNotice(shareMessage, "Alguém solicitou entrada. Autorize apenas se reconhecer a pessoa.");
  } else if (event.type === "signal") {
    await handleSignal(session, event.message);
  } else if (event.type === "viewer-left") {
    closePeerConnection();
    pendingViewerId = undefined;
    requestPanel.hidden = true;
    setNotice(shareMessage, "O convidado saiu. A sala continua aberta para outra solicitação.");
  }
}

async function handleViewerEvent(session, event) {
  if (event.type === "approved") {
    await startViewerConnection(session);
  } else if (event.type === "denied") {
    setNotice(joinMessage, "O dono do PC recusou a solicitação.", true);
    await stopViewer();
  } else if (event.type === "ended") {
    setNotice(joinMessage, "O dono encerrou a transmissão.");
    await stopViewer();
  } else if (event.type === "signal") {
    await handleSignal(session, event.message);
  }
}

async function pollEvents(session) {
  const query = new URLSearchParams({ roomId: session.roomId, peerId: session.peerId, token: session.token });
  while (roomSession === session && !session.abortController.signal.aborted) {
    try {
      const result = await apiRequest(session.baseUrl, `/api/events?${query}`, "GET", undefined, session.abortController.signal);
      for (const event of result.events) {
        if (roomSession !== session) return;
        if (session.role === "host") await handleHostEvent(session, event);
        else await handleViewerEvent(session, event);
      }
    } catch (error) {
      if (error.name === "AbortError" || roomSession !== session) return;
      setNotice(session.role === "host" ? shareMessage : joinMessage, error.message, true);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }
}

async function startSharing() {
  setNotice(shareMessage, "");
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setNotice(shareMessage, "Captura de tela indisponível. Abra o app por localhost e use um navegador atualizado.", true);
    return;
  }
  if (roomSession) {
    setNotice(shareMessage, "Encerre a sessão atual antes de iniciar outra.", true);
    return;
  }

  startShareButton.disabled = true;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    setLocalPreview(displayStream);
    const room = await apiRequest(location.origin, "/api/rooms", "POST", { password: roomPassword.value });
    roomSession = {
      role: "host",
      baseUrl: location.origin,
      roomId: room.roomId,
      peerId: "host",
      token: room.token,
      abortController: new AbortController(),
    };
    roomCode.textContent = room.roomId;
    roomCodeRow.hidden = false;
    startShareButton.hidden = true;
    stopShareButton.hidden = false;
    setNotice(shareMessage, displayStream.getAudioTracks().length
      ? "Tela e áudio capturados. Compartilhe o endereço LAN e o ID com o convidado."
      : "Tela capturada. Este navegador não forneceu áudio do sistema.");
    displayStream.getVideoTracks()[0]?.addEventListener("ended", () => stopSharing(), { once: true });
    pollEvents(roomSession);
  } catch (error) {
    displayStream?.getTracks().forEach((track) => track.stop());
    displayStream = undefined;
    preview.srcObject = null;
    preview.hidden = true;
    previewEmpty.hidden = false;
    liveIndicator.hidden = true;
    setNotice(shareMessage, error.name === "NotAllowedError"
      ? "Compartilhamento cancelado. Nenhuma tela está sendo transmitida."
      : error.message, error.name !== "NotAllowedError");
  } finally {
    startShareButton.disabled = false;
  }
}

async function stopSharing() {
  const session = roomSession;
  roomSession = undefined;
  session?.abortController.abort();
  if (session) {
    apiRequest(session.baseUrl, "/api/rooms/leave", "POST", sessionPayload(session)).catch(() => {});
  }
  closePeerConnection(true);
  displayStream?.getTracks().forEach((track) => track.stop());
  displayStream = undefined;
  startShareButton.hidden = false;
  stopShareButton.hidden = true;
  roomCodeRow.hidden = true;
  requestPanel.hidden = true;
  pendingViewerId = undefined;
  setNotice(shareMessage, "Transmissão encerrada.");
}

async function stopViewer(notifyServer = true) {
  const session = roomSession;
  roomSession = undefined;
  session?.abortController.abort();
  if (notifyServer && session) {
    apiRequest(session.baseUrl, "/api/rooms/leave", "POST", sessionPayload(session)).catch(() => {});
  }
  closePeerConnection(true);
  liveIndicator.hidden = true;
  document.querySelector("#leave-room").hidden = true;
}

startShareButton.addEventListener("click", startSharing);
stopShareButton.addEventListener("click", stopSharing);
document.querySelector("#leave-room").addEventListener("click", async () => {
  await stopViewer();
  setNotice(joinMessage, "Você saiu da sala.");
});

document.querySelector("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setNotice(joinMessage, "");
  if (roomSession) {
    setNotice(joinMessage, "Encerre a sessão atual antes de entrar em outra.", true);
    return;
  }
  try {
    const enteredAddress = hostAddressInput.value.trim();
    const hostUrl = new URL(enteredAddress);
    if (!['http:', 'https:'].includes(hostUrl.protocol)) throw new Error("Use um endereço HTTP válido do Y-Vision.");
    const baseUrl = hostUrl.origin;
    const result = await apiRequest(baseUrl, "/api/rooms/join", "POST", {
      roomId: joinRoomIdInput.value.trim(),
      password: document.querySelector("#join-password").value,
    });
    roomSession = {
      role: "viewer",
      baseUrl,
      roomId: result.roomId,
      peerId: result.peerId,
      token: result.token,
      abortController: new AbortController(),
    };
    document.querySelector("#leave-room").hidden = false;
    setNotice(joinMessage, "Pedido enviado. Aguarde a aprovação do dono do PC.");
    pollEvents(roomSession);
  } catch (error) {
    setNotice(joinMessage, error.message, true);
  }
});

async function handleViewerDecision(accepted) {
  if (!roomSession || roomSession.role !== "host" || !pendingViewerId) return;
  const session = roomSession;
  try {
    await apiRequest(session.baseUrl, "/api/rooms/decision", "POST", {
      roomId: session.roomId,
      token: session.token,
      viewerId: pendingViewerId,
      accepted,
    });
    requestPanel.hidden = true;
    if (accepted) {
      await startHostConnection(session);
    } else {
      pendingViewerId = undefined;
      setNotice(shareMessage, "Solicitação recusada.");
    }
  } catch (error) {
    setNotice(shareMessage, error.message, true);
  }
}

document.querySelector("#approve-viewer").addEventListener("click", () => handleViewerDecision(true));
document.querySelector("#deny-viewer").addEventListener("click", () => handleViewerDecision(false));

document.querySelector("#toggle-password").addEventListener("click", (event) => {
  const isHidden = roomPassword.type === "password";
  roomPassword.type = isHidden ? "text" : "password";
  event.currentTarget.textContent = isHidden ? "Ocultar" : "Mostrar";
  event.currentTarget.setAttribute("aria-label", isHidden ? "Ocultar senha" : "Mostrar senha");
});

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    showToast("Copiado para a área de transferência.");
  } catch {
    showToast(value);
  }
}

document.querySelector("#copy-room-code").addEventListener("click", () => copyText(roomCode.textContent));
document.querySelector("#copy-lan-address").addEventListener("click", () => {
  const address = document.querySelector("#lan-address").textContent;
  if (!address.startsWith("http")) return;
  copyText(address);
});

function openInfo(title, copy) {
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-copy").textContent = copy;
  infoDialog.showModal();
}

document.querySelector("#help-button").addEventListener("click", () => {
  openInfo("Conectar pela LAN", "Execute o Y-Vision nos dois PCs. No host, compartilhe o endereço LAN e o ID da sala. O convidado informa esses dados no próprio app. O host precisa aprovar cada pedido; o vídeo e o áudio seguem diretamente entre os PCs usando WebRTC, sem servidor externo.");
});
document.querySelector("#security-details").addEventListener("click", () => {
  openInfo("Controles de privacidade", "A sala aceita um convidado por vez e exige aprovação visível do dono. Encerrar a transmissão fecha a sala. A conexão de mídia é direta na rede local; esta versão não controla mouse ou teclado do sistema.");
});
document.querySelector("#profile-button").addEventListener("click", () => {
  openInfo("Conta e login", "Cadastro, login persistente e recuperação de conta ainda não estão conectados. Eles precisam de um backend de autenticação; este protótipo não pede nem armazena senhas.");
});
document.querySelector("#dialog-ok").addEventListener("click", () => infoDialog.close());
infoDialog.addEventListener("click", (event) => {
  if (event.target === infoDialog) infoDialog.close();
});
window.addEventListener("beforeunload", () => {
  displayStream?.getTracks().forEach((track) => track.stop());
  if (roomSession) {
    const payload = JSON.stringify(sessionPayload(roomSession));
    navigator.sendBeacon(`${roomSession.baseUrl}/api/rooms/leave`, new Blob([payload], { type: "application/json" }));
    roomSession.abortController.abort();
  }
});

apiRequest(location.origin, "/api/info").then((info) => {
  document.querySelector("#lan-address").textContent = info.lanUrl;
}).catch(() => {
  document.querySelector("#lan-address").textContent = "Servidor indisponível";
});