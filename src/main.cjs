const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  shell,
} = require("electron");

let mainWindow;
let selectedSourceId = null;
let authorizedControllerId = null;
let remoteInput;
const heldKeys = new Set();
const heldButtons = new Set();
let splashWindow;

function isAppWindow(event) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame?.url === pathToFileURL(path.join(__dirname, "index.html")).href
  );
}

function requireAppWindow(event) {
  if (!isAppWindow(event)) {
    throw new Error("Solicitacao IPC nao autorizada.");
  }
  return;
}

function makeWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: "#171820",
    title: "TelaJunta",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }, 850);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
    selectedSourceId = null;
    authorizedControllerId = null;
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
    }
    splashWindow = null;
    if (process.platform !== "darwin") app.quit();
  });
}

async function releaseRemoteInput() {
  if (!remoteInput) return;
  const { Button, Key, keyboard, mouse } = remoteInput;
  const releases = [];
  for (const key of heldKeys) {
    const mapped = Key[key];
    if (mapped !== undefined) releases.push(keyboard.releaseKey(mapped));
  }
  for (const button of heldButtons) {
    const mapped = Button[button];
    if (mapped !== undefined) releases.push(mouse.releaseButton(mapped));
  }
  heldKeys.clear();
  heldButtons.clear();
  const results = await Promise.allSettled(releases);
  for (const result of results) {
    if (result.status === "rejected") console.error("Falha ao soltar entrada remota:", result.reason);
  }
}

app.whenReady().then(() => {
  splashWindow = new BrowserWindow({
    width: 370,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: "#171820",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splashWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        '<!doctype html><html><body style="margin:0;display:grid;height:100vh;place-items:center;background:#171820;color:#eee;font:14px Segoe UI, sans-serif"><main style="text-align:center"><div style="margin:0 auto 15px;width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#6878f5;font-weight:800">TJ</div><strong style="font-size:20px">TelaJunta</strong><p style="color:#999">Sua tela, junto com a gente.</p></main></body></html>',
      ),
  );

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (!selectedSourceId || !mainWindow) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 1, height: 1 },
        });
        const source = sources.find((candidate) => candidate.id === selectedSourceId);
        selectedSourceId = null;
        if (!source) {
          callback({});
          return;
        }
        callback({
          video: source,
          ...(request.audioRequested && process.platform !== "linux"
            ? {
                audio:
                  process.platform === "darwin" ? "loopbackWithMute" : "loopback",
              }
            : {}),
        });
      } catch (error) {
        console.error("Falha ao selecionar a tela:", error);
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  ipcMain.handle("screens:list", async (event) => {
    requireAppWindow(event);
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      displayId: source.display_id || String(screen.getPrimaryDisplay().id),
    }));
  });

  ipcMain.handle("screens:select", (event, sourceId) => {
    requireAppWindow(event);
    if (typeof sourceId !== "string" || sourceId.length > 256) {
      throw new Error("Fonte de tela invalida.");
    }
    selectedSourceId = sourceId;
  });

  ipcMain.handle("control:authorize", async (event, peerId) => {
    requireAppWindow(event);
    if (peerId !== null && (typeof peerId !== "string" || peerId.length > 64)) {
      throw new Error("Participante de controle invalido.");
    }
    const changed = authorizedControllerId !== peerId;
    authorizedControllerId = peerId;
    if (changed) await releaseRemoteInput();
  });

  ipcMain.handle("control:input", async (event, peerId, input) => {
    requireAppWindow(event);
    if (!authorizedControllerId || peerId !== authorizedControllerId) return;
    if (!input || typeof input !== "object") return;

    if (!remoteInput) {
      remoteInput = await import("@nut-tree-fork/nut-js");
    }
    const { Button, Key, Point, keyboard, mouse } = remoteInput;
    const keyNames = {
      Backspace: "Backspace",
      Tab: "Tab",
      Enter: "Enter",
      NumpadEnter: "Enter",
      Escape: "Escape",
      Space: "Space",
      Delete: "Delete",
      Insert: "Insert",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      ShiftLeft: "LeftShift",
      ShiftRight: "RightShift",
      ControlLeft: "LeftControl",
      ControlRight: "RightControl",
      AltLeft: "LeftAlt",
      AltRight: "RightAlt",
      MetaLeft: "LeftSuper",
      MetaRight: "RightSuper",
      CapsLock: "CapsLock",
      Backquote: "Grave",
      Minus: "Minus",
      Equal: "Equal",
      BracketLeft: "LeftBracket",
      BracketRight: "RightBracket",
      Backslash: "Backslash",
      Semicolon: "Semicolon",
      Quote: "Quote",
      Comma: "Comma",
      Period: "Period",
      Slash: "Slash",
      NumpadAdd: "Add",
      NumpadSubtract: "Subtract",
      NumpadMultiply: "Multiply",
      NumpadDivide: "Divide",
      NumpadDecimal: "Decimal",
    };
    if (typeof input.code === "string") {
      if (/^Key[A-Z]$/.test(input.code)) {
        const key = Key[input.code.slice(3)];
        if (key === undefined) return;
        if (input.action === "down") {
          heldKeys.add(input.code.slice(3));
          await keyboard.pressKey(key);
        } else if (input.action === "up") {
          heldKeys.delete(input.code.slice(3));
          await keyboard.releaseKey(key);
        }
        return;
      }
      if (/^Digit[0-9]$/.test(input.code)) {
        const name = `Num${input.code.slice(5)}`;
        const key = Key[name];
        if (key === undefined) return;
        if (input.action === "down") {
          heldKeys.add(name);
          await keyboard.pressKey(key);
        } else if (input.action === "up") {
          heldKeys.delete(name);
          await keyboard.releaseKey(key);
        }
        return;
      }
      if (/^Numpad[0-9]$/.test(input.code)) {
        const name = `NumPad${input.code.slice(6)}`;
        const key = Key[name];
        if (key === undefined) return;
        if (input.action === "down") {
          heldKeys.add(name);
          await keyboard.pressKey(key);
        } else if (input.action === "up") {
          heldKeys.delete(name);
          await keyboard.releaseKey(key);
        }
        return;
      }
      if (/^F([1-9]|1[0-2])$/.test(input.code)) {
        const key = Key[input.code];
        if (key === undefined) return;
        if (input.action === "down") {
          heldKeys.add(input.code);
          await keyboard.pressKey(key);
        } else if (input.action === "up") {
          heldKeys.delete(input.code);
          await keyboard.releaseKey(key);
        }
        return;
      }
      const name = keyNames[input.code];
      const key = name && Key[name];
      if (key === undefined) return;
      if (input.action === "down") {
        heldKeys.add(name);
        await keyboard.pressKey(key);
      } else if (input.action === "up") {
        heldKeys.delete(name);
        await keyboard.releaseKey(key);
      }
      return;
    }

    if (input.type === "move") {
      if (
        !Number.isFinite(input.x) ||
        !Number.isFinite(input.y) ||
        input.x < 0 ||
        input.x > 1 ||
        input.y < 0 ||
        input.y > 1
      ) {
        return;
      }
      const displayId = Number(input.displayId);
      const display = screen
        .getAllDisplays()
        .find((candidate) => candidate.id === displayId);
      if (!display) return;
      const x = display.bounds.x + Math.round(input.x * (display.size.width - 1));
      const y = display.bounds.y + Math.round(input.y * (display.size.height - 1));
      await mouse.setPosition(new Point(x, y));
      return;
    }

    if (input.type === "button" && ["left", "right", "middle"].includes(input.button)) {
      const button = Button[input.button.toUpperCase()];
      if (button === undefined) return;
      if (input.action === "down") {
        heldButtons.add(input.button.toUpperCase());
        await mouse.pressButton(button);
      } else if (input.action === "up") {
        heldButtons.delete(input.button.toUpperCase());
        await mouse.releaseButton(button);
      }
      return;
    }

    if (input.type === "wheel") {
      const horizontal = Number.isFinite(input.x)
        ? Math.max(-10, Math.min(10, Math.trunc(input.x)))
        : 0;
      const vertical = Number.isFinite(input.y)
        ? Math.max(-10, Math.min(10, Math.trunc(input.y)))
        : 0;
      if (vertical < 0) await mouse.scrollUp(Math.abs(vertical));
      else if (vertical > 0) await mouse.scrollDown(vertical);
      if (horizontal < 0) await mouse.scrollLeft(Math.abs(horizontal));
      else if (horizontal > 0) await mouse.scrollRight(horizontal);
    }
  });

  makeWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) makeWindow();
  });
});

app.on("window-all-closed", () => {
  releaseRemoteInput().catch((error) => console.error("Falha ao encerrar controle remoto:", error));
  if (process.platform !== "darwin") app.quit();
});
