/** Types + helpers for the Electron desktop bridge (renderer-safe). */

export type SshProbe = {
  hasAq: boolean;
  aqVersion: string | null;
  home: string | null;
  uname: string | null;
  needsBootstrap: boolean;
  error?: string;
};

export type SshConnectResult = {
  connectionId: string;
  host: string;
  username: string;
  port: number;
  probe: SshProbe;
};

export type SshDirEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
};

export type AquinDesktopApi = {
  isDesktop: () => Promise<boolean>;
  pickPrivateKey: () => Promise<string | null>;
  setTrafficLightPosition?: (pos: { x: number; y: number }) => Promise<boolean>;
  getFullscreen?: () => Promise<boolean>;
  onFullscreenChange?: (cb: (fullscreen: boolean) => void) => () => void;
  ssh: {
    request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  };
};

declare global {
  interface Window {
    aquinDesktop?: AquinDesktopApi;
  }
}

export function getDesktopApi(): AquinDesktopApi | null {
  if (typeof window === "undefined") return null;
  return window.aquinDesktop ?? null;
}

export function isAquinDesktop(): boolean {
  return Boolean(getDesktopApi());
}

export async function desktopSshRequest<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const api = getDesktopApi();
  if (!api) {
    throw new Error("SSH is only available in the Aquin desktop app");
  }
  return api.ssh.request<T>(method, params);
}
