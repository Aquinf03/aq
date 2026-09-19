const { contextBridge, ipcRenderer } = require("electron");

/**
 * Safe API exposed to the Next.js renderer.
 * SSH private keys never pass through page JS except as filesystem paths the user picked.
 */
contextBridge.exposeInMainWorld("aquinDesktop", {
  isDesktop: () => ipcRenderer.invoke("desktop:isDesktop"),
  pickPrivateKey: () => ipcRenderer.invoke("desktop:pickPrivateKey"),
  /** Reposition macOS traffic lights to match the in-app titlebar. */
  setTrafficLightPosition: (pos) =>
    ipcRenderer.invoke("desktop:setTrafficLightPosition", pos),
  getFullscreen: () => ipcRenderer.invoke("desktop:getFullscreen"),
  onFullscreenChange: (cb) => {
    const handler = (_event, fullscreen) => cb(Boolean(fullscreen));
    ipcRenderer.on("desktop:fullscreen", handler);
    return () => ipcRenderer.removeListener("desktop:fullscreen", handler);
  },
  ssh: {
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    request: (method, params) => ipcRenderer.invoke("ssh:request", { method, params }),
  },
  /**
   * Run local `aq` CLI. Returns { ok, code, stdout, stderr }.
   * @param {{ args: string[], cwd?: string }} opts
   */
  aqRun: (opts) => ipcRenderer.invoke("aq:run", opts),
  /** Read ~/.aquin/places.json */
  aqPlaces: () => ipcRenderer.invoke("aq:places"),
  /** Upsert an SSH place into ~/.aquin/places.json */
  aqPlacesUpsert: (place) => ipcRenderer.invoke("aq:placesUpsert", place),
});
