/**
 * Electron main — desktop-only Aquin control plane.
 * Spawns the Next.js UI server, Python AsyncSSH sidecar, then opens the window.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { SshBridge } = require("./ssh-bridge.cjs");

const ROOT = path.resolve(__dirname, "../..");
const isDev = !app.isPackaged;
const UI_PORT = Number(process.env.AQUIN_UI_PORT || 3000);
const UI_URL = process.env.AQUIN_DESKTOP_URL || `http://localhost:${UI_PORT}`;

/** @type {Electron.BrowserWindow | null} */
let mainWindow = null;
/** @type {InstanceType<typeof SshBridge> | null} */
let ssh = null;
/** @type {import('node:child_process').ChildProcess | null} */
let nextProc = null;

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
    require("node:fs").accessSync(venvPy);
    return venvPy;
  } catch {
    return process.platform === "win32" ? "python" : "python3";
  }
}

function waitForUrl(url, { timeoutMs = 60_000 } = {}) {
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

function startNextServer() {
  if (process.env.AQUIN_DESKTOP_URL) {
    // External UI already running (advanced); don't spawn Next.
    return Promise.resolve();
  }

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = isDev
    ? ["next", "dev", "--port", String(UI_PORT), "--hostname", "localhost"]
    : ["next", "start", "--port", String(UI_PORT), "--hostname", "localhost"];

  nextProc = spawn(npx, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  nextProc.stdout?.on("data", (buf) => {
    const line = buf.toString("utf8").trim();
    if (line) console.log("[ui]", line);
  });
  nextProc.stderr?.on("data", (buf) => {
    const line = buf.toString("utf8").trim();
    if (line) console.error("[ui]", line);
  });
  nextProc.on("exit", (code, signal) => {
    console.error(`[ui] Next.js exited (code=${code}, signal=${signal})`);
    nextProc = null;
  });

  return waitForUrl(UI_URL);
}

function stopNextServer() {
  if (!nextProc) return;
  try {
    nextProc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  nextProc = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Aquin",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL(UI_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    void shell.openExternal(openUrl);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle("desktop:isDesktop", () => true);

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
    console.log("[aquin-desktop] starting UI…");
    await startNextServer();
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
  stopNextServer();
}

app.on("window-all-closed", () => {
  shutdown();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdown();
});
