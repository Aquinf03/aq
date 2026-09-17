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

export type AqRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type FleetJobRow = {
  id: string;
  place: string;
  remoteDir: string;
  status: string;
  code: number | null;
  command: string[];
  started: string;
  ended: string | null;
  tags?: Record<string, string>;
  pool?: string;
  managed?: {
    enabled: boolean;
    prefer: string;
    maxRetries: number;
    retries: number;
  };
  gpuDevices?: number[];
  worldSize?: number;
  detail?: string;
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
  aqRun?: (opts: { args: string[]; cwd?: string }) => Promise<AqRunResult>;
  aqPlaces?: () => Promise<{
    places: Record<string, { kind: string; host?: string; members?: string[] }>;
    error?: string;
  }>;
  aqPlacesUpsert?: (place: {
    name: string;
    host: string;
    user?: string;
    port?: number;
    key?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    places?: Record<string, { kind: string; host?: string; members?: string[] }>;
  }>;
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

export async function desktopAqRun(args: string[], cwd?: string): Promise<AqRunResult> {
  const api = getDesktopApi();
  if (!api?.aqRun) {
    throw new Error("aq bridge is only available in the Aquin desktop app");
  }
  return api.aqRun({ args, cwd });
}

function lastJsonObject(out: string): string {
  const lines = out
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("{") && l.endsWith("}"));
  return lines[lines.length - 1] || out.trim();
}

export async function fetchFleetJobs(opts?: {
  on?: string;
  all?: boolean;
}): Promise<{ jobs: FleetJobRow[]; error?: string }> {
  const args = ["jobs", "list", "--json"];
  if (opts?.on) args.push("--on", opts.on);
  else args.push("--all");
  try {
    const r = await desktopAqRun(args);
    if (!r.ok && !r.stdout.trim()) {
      return {
        jobs: [],
        error: r.error || r.stderr.trim() || "aq jobs list failed",
      };
    }
    const raw = lastJsonObject(r.stdout);
    const data = JSON.parse(raw || "{}") as { jobs?: FleetJobRow[] };
    return { jobs: Array.isArray(data.jobs) ? data.jobs : [] };
  } catch (e) {
    return {
      jobs: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchFleetPlaces(): Promise<
  { name: string; kind: string; label: string }[]
> {
  const api = getDesktopApi();
  if (!api?.aqPlaces) return [];
  const data = await api.aqPlaces();
  return Object.entries(data.places || {})
    .map(([name, p]) => ({
      name,
      kind: p.kind,
      label:
        p.kind === "pool"
          ? `${name} (pool)`
          : `${name}${p.host ? ` · ${p.host}` : ""}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertFleetSshPlace(place: {
  name: string;
  host: string;
  user?: string;
  port?: number;
  key?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const api = getDesktopApi();
  if (!api?.aqPlacesUpsert) {
    return { ok: false, error: "Adding places requires the Aquin desktop app." };
  }
  const r = await api.aqPlacesUpsert(place);
  return { ok: Boolean(r.ok), error: r.error };
}
