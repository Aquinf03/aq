const { contextBridge, ipcRenderer } = require("electron");

/**
 * Safe API exposed to the Next.js renderer.
 * SSH private keys never pass through page JS except as filesystem paths the user picked.
 */
contextBridge.exposeInMainWorld("aquinDesktop", {
  isDesktop: () => ipcRenderer.invoke("desktop:isDesktop"),
  pickPrivateKey: () => ipcRenderer.invoke("desktop:pickPrivateKey"),
  ssh: {
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    request: (method, params) => ipcRenderer.invoke("ssh:request", { method, params }),
  },
});
