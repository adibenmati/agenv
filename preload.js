// preload.js — Agenv Electron preload script
// Exposes a minimal API to the renderer via contextBridge (sandbox: true)
"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
