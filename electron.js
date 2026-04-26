// electron.js — Agenv desktop app
"use strict";

const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
function log(msg) {
  console.log(msg);
}

const TOKEN = require("crypto").randomBytes(16).toString("hex");

let PORT = null;
let mainWindow = null;
let serverProcess = null;

// Find a free port, starting from preferred
function findFreePort(preferred = 7681) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      srv.close(() => resolve(preferred));
    });
    srv.on("error", () => {
      // Preferred port busy — let OS pick one
      const srv2 = net.createServer();
      srv2.listen(0, "127.0.0.1", () => {
        const port = srv2.address().port;
        srv2.close(() => resolve(port));
      });
    });
  });
}

function getURL() {
  return `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
}

// Wait for the server to accept connections
function waitForServer(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        if (Date.now() - start > timeout) {
          reject(new Error("Server did not start within " + timeout + "ms"));
        } else {
          setTimeout(attempt, 300);
        }
      });
    }
    attempt();
  });
}

function startServer() {
  // Use the system node (not Electron's) to run server.js
  // This avoids native module (node-pty) ABI mismatch issues
  const nodePath = process.env.NODE_PATH_OVERRIDE || "node";
  log("[electron] Starting server on port " + PORT + "...");

  serverProcess = spawn(nodePath, [
    path.join(__dirname, "server.js"),
    "--port", String(PORT),
    "--host", "127.0.0.1",
    "--token", TOKEN,
    "--no-qr",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON: "1" },
    windowsHide: true,
  });

  serverProcess.stdout.on("data", (d) => process.stdout.write(d));
  serverProcess.stderr.on("data", (d) => process.stderr.write(d));

  serverProcess.on("error", (err) => {
    log("[electron] Failed to start server: " + err.message);
    dialog.showErrorBox("Agenv — Server Error", "Failed to start the embedded server:\n\n" + err.message);
    app.quit();
  });

  serverProcess.on("exit", (code) => {
    log("[electron] Server exited with code " + code);
    serverProcess = null;
    // If window is still open, the server crashed unexpectedly
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Server Crashed",
        message: "The Agenv server exited unexpectedly (code " + code + ").",
        buttons: ["Restart", "Quit"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          startServer();
          waitForServer(PORT).then(() => mainWindow.loadURL(getURL())).catch(() => app.quit());
        } else {
          app.quit();
        }
      });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: "Agenv",
    icon: path.join(__dirname, "assets", "icon.svg"),
    backgroundColor: "#0d1117",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
    frame: true,
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(getURL());

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Build menu with standard shortcuts
function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => mainWindow?.webContents.sendInputEvent({ type: "keyDown", keyCode: "t", modifiers: ["control"] }) },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { role: "quit", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "copy", accelerator: "CmdOrCtrl+Shift+C" },
        { role: "paste", accelerator: "CmdOrCtrl+Shift+V" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools", accelerator: "F12" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Agenv",
          click: () => {
            dialog.showMessageBox(mainWindow || BrowserWindow.getFocusedWindow(), {
              type: "info",
              title: "About Agenv",
              message: "Agenv",
              detail: "The agent development environment.\n\nServer port: " + PORT + "\nElectron: " + process.versions.electron + "\nNode: " + process.versions.node + "\nChrome: " + process.versions.chrome,
              buttons: ["OK"],
            });
          },
        },
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+Shift+/", click: () => mainWindow?.webContents.executeJavaScript("document.getElementById('help-overlay')?.classList.toggle('show')") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  log("[electron] App ready, finding free port...");

  try {
    PORT = await findFreePort(parseInt(process.env.PORT, 10) || 7681);
    log("[electron] Using port " + PORT);
  } catch (e) {
    dialog.showErrorBox("Agenv — Port Error", "Could not find a free port:\n\n" + e.message);
    app.quit();
    return;
  }

  startServer();

  try {
    await waitForServer(PORT);
    log("[electron] Server is up, opening window...");
  } catch (e) {
    log("[electron] " + e.message);
    dialog.showErrorBox("Agenv — Server Timeout", "The server did not start in time.\n\n" + e.message);
    app.quit();
    return;
  }

  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
