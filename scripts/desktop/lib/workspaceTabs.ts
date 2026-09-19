/** Persist workspace top-tab bar across reloads (localStorage). */

export type WorkspaceTabKind = "home" | "jobs";

export type WorkspaceOpenTab = {
  id: string;
  kind: WorkspaceTabKind;
};

export type WorkspaceTabsState = {
  tabs: WorkspaceOpenTab[];
  activeId: string;
  seq: number;
};

const STORAGE_KEY = "aquin-workspace-tabs-v1";
const KINDS = new Set<WorkspaceTabKind>(["home", "jobs"]);

function defaultState(): WorkspaceTabsState {
  return {
    tabs: [{ id: "home-1", kind: "home" }],
    activeId: "home-1",
    seq: 2,
  };
}

function isValid(raw: unknown): raw is WorkspaceTabsState {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tabs) || typeof o.activeId !== "string" || typeof o.seq !== "number") {
    return false;
  }
  if (!o.tabs.length) return false;
  for (const t of o.tabs) {
    if (!t || typeof t !== "object") return false;
    const tab = t as Record<string, unknown>;
    if (typeof tab.id !== "string" || !KINDS.has(tab.kind as WorkspaceTabKind)) return false;
  }
  return o.tabs.some(t => (t as WorkspaceOpenTab).id === o.activeId);
}

export function loadWorkspaceTabs(): WorkspaceTabsState {
  if (typeof window === "undefined") return defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as unknown;
    if (!isValid(parsed)) return defaultState();
    return {
      tabs: parsed.tabs.map(t => ({ id: t.id, kind: t.kind })),
      activeId: parsed.activeId,
      seq: Math.max(parsed.seq, parsed.tabs.length + 1),
    };
  } catch {
    return defaultState();
  }
}

export function saveWorkspaceTabs(state: WorkspaceTabsState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

export function nextTabId(kind: WorkspaceTabKind, seq: number): string {
  return `${kind}-${seq}`;
}
