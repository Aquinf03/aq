/**
 * Electron main — desktop-only Aquin control plane.
 * Spawns Vite UI + Next API (for /api + /auth), Python AsyncSSH sidecar, then opens the window.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { SshBridge } = require("./ssh-bridge.cjs");

const ROOT = path.resolve(__dirname, "../..");
const isDev = !app.isPackaged;
const UI_PORT = Number(process.env.AQUIN_UI_PORT || 3000);
const API_PORT = Number(process.env.AQUIN_API_PORT || 3001);
const UI_URL = process.env.AQUIN_DESKTOP_URL || `http://localhost:${UI_PORT}`;

/** @type {Electron.BrowserWindow | null} */
let mainWindow = null;
/** @type {InstanceType<typeof SshBridge> | null} */
let ssh = null;
/** @type {import('node:child_process').ChildProcess | null} */
let uiProc = null;
/** @type {import('node:child_process').ChildProcess | null} */
let apiProc = null;

function resolveIcon() {
  const png = path.join(ROOT, "desktop", "resources", "icon.png");
  const pub = path.join(ROOT, "public", "icon.png");
  // Electron dock.setIcon on macOS is unreliable with some .icns files — use PNG.
  if (fs.existsSync(png)) return png;
  return pub;
}

function resolvePython() {
  const fromEnv = process.env.AQUIN_PYTHON;
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(ROOT, fromEnv);
  }
  const venvPy = path.join(
    ROOT,
    "desktop",
    "ssh-service",
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  try {
    fs.accessSync(venvPy);
    return venvPy;
  } catch {
    return process.platform === "win32" ? "python" : "python3";
  }
}

function waitForUrl(url, { timeoutMs = 90_000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(undefined);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for UI at ${url}`));
          return;
        }
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function spawnLogged(label, npxArgs, envExtra = {}) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(npx, npxArgs, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0", ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  proc.stdout?.on("data", (buf) => {
    const line = buf.toString("utf8").trim();
    if (line) console.log(`[${label}]`, line);
  });
  proc.stderr?.on("data", (buf) => {
    const line = buf.toString("utf8").trim();
    if (line) console.error(`[${label}]`, line);
  });
  proc.on("exit", (code, signal) => {
    console.error(`[${label}] exited (code=${code}, signal=${signal})`);
  });
  return proc;
}

function startServers() {
  if (process.env.AQUIN_DESKTOP_URL) {
    return Promise.resolve();
  }

  // Next remains as the API/auth process only (same route handlers).
  apiProc = spawnLogged(
    "api",
    ["next", "dev", "--port", String(API_PORT), "--hostname", "localhost"],
    { AQUIN_API_PORT: String(API_PORT) },
  );

  uiProc = spawnLogged(
    "ui",
    isDev
      ? ["vite", "--port", String(UI_PORT), "--host", "localhost"]
      : ["vite", "preview", "--port", String(UI_PORT), "--host", "localhost"],
    { AQUIN_UI_PORT: String(UI_PORT), AQUIN_API_PORT: String(API_PORT) },
  );

  uiProc.on("exit", () => {
    uiProc = null;
  });
  apiProc.on("exit", () => {
    apiProc = null;
  });

  return waitForUrl(UI_URL);
}

function stopServers() {
  for (const proc of [uiProc, apiProc]) {
    if (!proc) continue;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  uiProc = null;
  apiProc = null;
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const iconPath = resolveIcon();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Aquin",
    show: false,
    icon: iconPath,
    ...(isMac
      ? {
          // `hidden` (not hiddenInset) so trafficLightPosition is exact — no extra OS inset.
          // Keep in sync with lib/titlebarChrome.ts (TITLEBAR_H=36, y:10).
          titleBarStyle: "hidden",
          trafficLightPosition: { x: 14, y: 10 },
        }
      : {
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isMac && app.dock) {
    try {
      app.dock.setIcon(iconPath);
    } catch (err) {
      console.warn("[aquin-desktop] dock icon:", err);
    }
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL(UI_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    void shell.openExternal(openUrl);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const sendFullscreen = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("desktop:fullscreen", mainWindow.isFullScreen());
  };
  mainWindow.on("enter-full-screen", sendFullscreen);
  mainWindow.on("leave-full-screen", sendFullscreen);
}

function registerIpc() {
  ipcMain.handle("desktop:isDesktop", () => true);

  ipcMain.handle("desktop:getFullscreen", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isFullScreen();
  });

  ipcMain.handle("desktop:setTrafficLightPosition", (_event, pos) => {
    if (process.platform !== "darwin" || !mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    try {
      mainWindow.setWindowButtonPosition({ x: Math.round(x), y: Math.round(y) });
      return true;
    } catch (err) {
      console.warn("[aquin-desktop] setWindowButtonPosition:", err);
      return false;
    }
  });

  ipcMain.handle("desktop:pickPrivateKey", async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: "Select SSH private key",
      properties: ["openFile", "showHiddenFiles"],
      message: "Choose an SSH private key (e.g. ~/.ssh/id_ed25519)",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("ssh:request", async (_event, payload) => {
    if (!ssh) throw new Error("SSH service is not running");
    return ssh.request(payload.method, payload.params ?? {});
  });
}

app.whenReady().then(async () => {
  registerIpc();

  ssh = new SshBridge({
    root: ROOT,
    pythonPath: resolvePython(),
  });
  try {
    await ssh.start();
    console.log("[aquin-desktop] SSH sidecar ready");
  } catch (err) {
    console.error("[aquin-desktop] SSH sidecar failed to start:", err);
  }

  try {
    console.log("[aquin-desktop] starting Vite UI + API…");
    await startServers();
    console.log("[aquin-desktop] UI ready at", UI_URL);
  } catch (err) {
    console.error("[aquin-desktop] UI failed to start:", err);
    dialog.showErrorBox("Aquin", `Failed to start UI:\n${err instanceof Error ? err.message : String(err)}`);
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  void ssh?.stop();
  ssh = null;
  stopServers();
}

app.on("window-all-closed", () => {
  shutdown();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdown();
});
