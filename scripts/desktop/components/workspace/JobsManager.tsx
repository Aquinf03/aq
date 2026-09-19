"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowsDownUp,
  CaretDown,
  Check,
  CircleNotch,
  FunnelSimple,
  Key,
  Plus,
  X,
} from "@phosphor-icons/react";
import {
  desktopAqRun,
  fetchFleetJobs,
  fetchFleetPlaces,
  getDesktopApi,
  isAquinDesktop,
  upsertFleetSshPlace,
  type FleetJobRow,
} from "@/lib/desktop";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JobsDetailPanel } from "@/components/workspace/JobsDetailPanel";

type PlaceRow = { name: string; kind: string; label: string };

type DraftJob = {
  name: string;
  command: string;
  places: string[];
  gpu: string;
  manage: boolean;
  priority: "normal" | "high" | "urgent";
};

const emptyDraft = (): DraftJob => ({
  name: "",
  command: "aq train",
  places: [],
  gpu: "",
  manage: false,
  priority: "normal",
});

function statusMeta(status: string): {
  label: string;
  className: string;
} {
  const s = status.toLowerCase();
  if (s === "running") {
    return {
      label: "Running",
      className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300",
    };
  }
  if (s === "exited") {
    return {
      label: "Completed",
      className: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
    };
  }
  if (s === "canceled") {
    return {
      label: "Canceled",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
    };
  }
  if (s === "unreachable" || s === "error" || s === "missing") {
    return {
      label: s === "unreachable" ? "Unreachable" : s === "missing" ? "Missing" : "Error",
      className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
    };
  }
  return {
    label: status || "Unknown",
    className: "bg-stone-100 text-stone-700 dark:bg-white/10 dark:text-stone-300",
  };
}

function priorityMeta(job: FleetJobRow): { label: string; dot: string } {
  const p = job.tags?.priority || job.tags?.prio;
  if (p === "urgent" || p === "1") return { label: "Urgent", dot: "bg-red-500" };
  if (p === "high" || p === "2") return { label: "High", dot: "bg-orange-400" };
  if (job.managed?.enabled) return { label: "Managed", dot: "bg-sky-500" };
  if (job.tags?.sweep) return { label: "Sweep", dot: "bg-violet-500" };
  return { label: "Normal", dot: "bg-emerald-500" };
}

function formatStarted(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function cmdLabel(cmd: string[]): string {
  const s = cmd.join(" ");
  return s.length > 72 ? s.slice(0, 69) + "…" : s || "(no command)";
}

const cell =
  "h-10 max-w-0 overflow-hidden border border-t-0 border-l-0 border-black/10 px-3 align-middle dark:border-white/[0.08]";

const draftCell =
  "h-11 max-w-0 overflow-hidden border border-t-0 border-l-0 border-black/10 px-2 align-middle dark:border-white/[0.08]";

const toolBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-stone-300/90 bg-transparent px-2.5 text-[13px] font-medium text-stone-600 outline-none transition-colors hover:bg-stone-100/90 dark:border-white/20 dark:text-stone-300 dark:hover:bg-white/[0.06]";

const PRIO_OPTS = [
  { key: "normal" as const, label: "Normal", dot: "bg-emerald-500" },
  { key: "high" as const, label: "High", dot: "bg-orange-400" },
  { key: "urgent" as const, label: "Urgent", dot: "bg-red-500" },
];

function PlacePicker({
  places,
  selected,
  onChange,
  onPlacesChanged,
  multi = true,
}: {
  places: PlaceRow[];
  selected: string[];
  onChange: (names: string[]) => void;
  onPlacesChanged: () => void;
  multi?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [keyPath, setKeyPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const label =
    selected.length === 0
      ? "Select SSH"
      : selected.length === 1
        ? places.find(p => p.name === selected[0])?.label || selected[0]
        : `${selected.length} places`;

  const toggle = (n: string) => {
    if (multi) {
      onChange(
        selected.includes(n) ? selected.filter(x => x !== n) : [...selected, n],
      );
    } else {
      onChange([n]);
    }
  };

  const savePlace = async () => {
    setSaving(true);
    setErr(null);
    const r = await upsertFleetSshPlace({
      name: name.trim(),
      host: host.trim(),
      user: user.trim() || undefined,
      port: Number(port) || 22,
      key: keyPath.trim() || undefined,
    });
    setSaving(false);
    if (!r.ok) {
      setErr(r.error || "Could not save place");
      return;
    }
    const saved = name.trim();
    setAdding(false);
    setName("");
    setHost("");
    setUser("");
    setPort("22");
    setKeyPath("");
    onPlacesChanged();
    onChange(multi ? [...new Set([...selected, saved])] : [saved]);
  };

  return (
    <DropdownMenu
      onOpenChange={open => {
        if (!open) {
          setAdding(false);
          setErr(null);
        }
      }}
    >
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 max-w-full items-center gap-1 truncate rounded-md px-2 text-left text-[13px] outline-none transition-colors",
          selected.length
            ? "text-stone-800 hover:bg-black/[0.04] dark:text-stone-200 dark:hover:bg-white/[0.06]"
            : "text-stone-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
        )}
        onClick={e => e.stopPropagation()}
      >
        <Key className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
        <CaretDown className="size-3 shrink-0 opacity-50" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72 p-1"
        onClick={e => e.stopPropagation()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        {adding ? (
          <div className="space-y-2 p-2">
            <DropdownMenuLabel className="px-0">Add SSH place</DropdownMenuLabel>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Name (e.g. lab)"
              className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-[12px] outline-none dark:border-white/10 dark:bg-[#111]"
            />
            <input
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="Host"
              className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-[12px] outline-none dark:border-white/10 dark:bg-[#111]"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={user}
                onChange={e => setUser(e.target.value)}
                placeholder="User"
                className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-[12px] outline-none dark:border-white/10 dark:bg-[#111]"
              />
              <input
                value={port}
                onChange={e => setPort(e.target.value)}
                placeholder="Port"
                className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-[12px] outline-none dark:border-white/10 dark:bg-[#111]"
              />
            </div>
            <div className="flex gap-1.5">
              <input
                value={keyPath}
                onChange={e => setKeyPath(e.target.value)}
                placeholder="Key path (optional)"
                className="h-8 min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 text-[12px] outline-none dark:border-white/10 dark:bg-[#111]"
              />
              <button
                type="button"
                className="h-8 shrink-0 rounded-md border border-black/10 px-2 text-[11px] dark:border-white/10"
                onClick={() => {
                  void getDesktopApi()
                    ?.pickPrivateKey()
                    .then(p => {
                      if (p) setKeyPath(p);
                    });
                }}
              >
                Pick
              </button>
            </div>
            {err ? <p className="text-[11px] text-red-600 dark:text-red-400">{err}</p> : null}
            <div className="flex justify-end gap-1.5 pt-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[12px] text-stone-500 hover:bg-black/[0.04]"
                onClick={() => setAdding(false)}
              >
                Back
              </button>
              <button
                type="button"
                disabled={saving || !name.trim() || !host.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-stone-900 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                onClick={() => void savePlace()}
              >
                {saving ? <CircleNotch className="size-3 animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <DropdownMenuLabel>SSH places</DropdownMenuLabel>
            {!places.length ? (
              <p className="px-2 py-2 text-[12px] text-stone-500">No places yet — add one.</p>
            ) : (
              places.map(p => (
                <DropdownMenuItem
                  key={p.name}
                  onSelect={e => {
                    e.preventDefault();
                    toggle(p.name);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  {selected.includes(p.name) ? (
                    <Check className="size-3.5 shrink-0" weight="bold" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={e => {
                e.preventDefault();
                setAdding(true);
              }}
            >
              <Plus className="size-3.5" />
              Add SSH…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function JobsManager({
  onConnectSsh: _onConnectSsh,
  openedFolder: _openedFolder,
}: {
  onConnectSsh?: () => void;
  openedFolder?: { host: string; path: string } | null;
}) {
  const desktop = isAquinDesktop();
  const [jobs, setJobs] = useState<FleetJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<"started" | "status" | "place" | "name">("started");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [draft, setDraft] = useState<DraftJob | null>(null);
  const [creating, setCreating] = useState(false);

  const refreshPlaces = useCallback(async () => {
    if (!desktop) return;
    const list = await fetchFleetPlaces();
    setPlaces(list);
    setDraft(prev => {
      if (!prev || prev.places.length) return prev;
      const first = list.find(p => p.kind === "ssh")?.name || list[0]?.name;
      return first ? { ...prev, places: [first] } : prev;
    });
  }, [desktop]);

  const refresh = useCallback(async () => {
    if (!desktop) {
      setLoading(false);
      setError("Open this page in the Aquin desktop app to manage compute jobs.");
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetchFleetJobs({ all: true });
    setJobs(res.jobs);
    setError(res.error ?? null);
    setLoading(false);
  }, [desktop]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void refreshPlaces();
  }, [refreshPlaces]);

  const filtered = useMemo(() => {
    let rows = jobs;
    if (statusFilter !== "all") {
      rows = rows.filter(j => j.status.toLowerCase() === statusFilter);
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av =
        sortKey === "started"
          ? a.started
          : sortKey === "status"
            ? a.status
            : sortKey === "place"
              ? a.place
              : a.tags?.name || a.tags?.sweep || a.id;
      const bv =
        sortKey === "started"
          ? b.started
          : sortKey === "status"
            ? b.status
            : sortKey === "place"
              ? b.place
              : b.tags?.name || b.tags?.sweep || b.id;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [jobs, sortKey, sortDir, statusFilter]);

  const detailJob = detailId ? jobs.find(j => j.id === detailId) ?? null : null;

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(j => j.id)));
  };

  const loadLogs = useCallback(async (id: string) => {
    setLogsLoading(true);
    setLogs("");
    try {
      const r = await desktopAqRun(["jobs", "logs", id, "-n", "200"]);
      setLogs((r.stdout || r.stderr || "").trim() || "(empty log)");
    } catch (e) {
      setLogs(e instanceof Error ? e.message : String(e));
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const openDetail = (id: string) => {
    setDetailId(id);
    void loadLogs(id);
  };

  const runAction = async (id: string, args: string[]) => {
    setBusyId(id);
    try {
      const r = await desktopAqRun(args);
      if (!r.ok) {
        setError((r.stderr || r.stdout || r.error || "action failed").trim());
      }
      await refresh();
      if (detailId === id) await loadLogs(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const bulkDown = async () => {
    const ids = [...selected];
    for (const id of ids) {
      await runAction(id, ["jobs", "down", id]);
    }
    setSelected(new Set());
  };

  const startDraft = async () => {
    if (!draft) return;
    const targets = draft.places;
    const parts = draft.command.trim().split(/\s+/).filter(Boolean);
    if (!targets.length) {
      setError("Pick at least one SSH place");
      return;
    }
    if (!parts.length) {
      setError("Enter a command to run");
      return;
    }
    const name = draft.name.trim();
    if (name && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      setError("Name: letters, numbers, . _ - (max 64 chars)");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const gpuN = Number(draft.gpu);
      for (const place of targets) {
        const args = ["jobs", "run", "--json", "--tag", `priority=${draft.priority}`];
        if (name) args.push("--name", name);
        args.push("--on", place);
        if (draft.gpu.trim() && Number.isFinite(gpuN) && gpuN > 0) {
          args.push("--gpu", String(gpuN));
        }
        if (draft.manage) args.push("--manage");
        args.push("--", ...parts);
        const r = await desktopAqRun(args);
        if (!r.ok) {
          setError((r.stderr || r.stdout || `failed on ${place}`).trim());
          break;
        }
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const beginNew = () => {
    const first = places.find(p => p.kind === "ssh")?.name || places[0]?.name;
    setDraft({
      ...emptyDraft(),
      places: first ? [first] : [],
    });
    setDetailId(null);
  };

  useEffect(() => {
    const onNew = () => {
      const first = places.find(p => p.kind === "ssh")?.name || places[0]?.name;
      setDraft({
        ...emptyDraft(),
        places: first ? [first] : [],
      });
      setDetailId(null);
    };
    window.addEventListener("aquin:jobs-new", onNew);
    return () => window.removeEventListener("aquin:jobs-new", onNew);
  }, [places]);

  const prioLabel = (key: DraftJob["priority"]) =>
    PRIO_OPTS.find(p => p.key === key) ?? PRIO_OPTS[0];

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger className={toolBtn}>
                <ArrowsDownUp className="size-3.5" weight="regular" />
                Sort
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {(
                  [
                    ["started", "Started"],
                    ["status", "Status"],
                    ["place", "Place"],
                    ["name", "Name"],
                  ] as const
                ).map(([key, label]) => (
                  <DropdownMenuItem
                    key={key}
                    onSelect={() => {
                      if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
                      else {
                        setSortKey(key);
                        setSortDir(key === "started" ? "desc" : "asc");
                      }
                    }}
                  >
                    {label}
                    {sortKey === key ? (
                      <span className="ml-auto text-[10px] text-stone-400">
                        {sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className={toolBtn}>
                <FunnelSimple className="size-3.5" weight="regular" />
                Filter
                {statusFilter !== "all" ? (
                  <span className="rounded-full bg-stone-200/80 px-1.5 text-[10px] font-semibold text-stone-600 dark:bg-white/10 dark:text-stone-300">
                    1
                  </span>
                ) : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {(
                  [
                    ["all", "All statuses"],
                    ["running", "Running"],
                    ["exited", "Completed"],
                    ["canceled", "Canceled"],
                    ["unreachable", "Unreachable"],
                    ["error", "Error"],
                    ["missing", "Missing"],
                  ] as const
                ).map(([key, label]) => (
                  <DropdownMenuItem key={key} onSelect={() => setStatusFilter(key)}>
                    {label}
                    {statusFilter === key ? (
                      <Check className="ml-auto size-3.5" weight="bold" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {selected.size > 0 ? (
              <div className="ml-1 flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-sm text-stone-700 dark:border-white/10 dark:bg-[#111] dark:text-stone-200">
                <span className="font-medium">{selected.size} Selected</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-white/10"
                  onClick={() => setSelected(new Set())}
                  aria-label="Clear selection"
                >
                  <X className="size-3.5" weight="bold" />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger className="ml-1 text-xs font-semibold text-stone-700 outline-none hover:underline dark:text-stone-200">
                    Actions
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-40">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void bulkDown()}
                    >
                      Stop selected
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="whitespace-nowrap text-[13px] text-stone-500 dark:text-stone-400">
              {filtered.length === 1 ? "1 job" : `${filtered.length} jobs`}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-stone-200/80 px-2.5 text-[13px] font-medium text-stone-800 outline-none transition-colors hover:bg-stone-300/80 disabled:opacity-50 dark:bg-white/10 dark:text-stone-100 dark:hover:bg-white/[0.14]"
              >
                <ArrowClockwise className={cn("size-3.5", loading && "animate-spin")} />
                Refresh
              </button>
              <button
                type="button"
                onClick={beginNew}
                disabled={!desktop || Boolean(draft)}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-stone-900 px-3 text-[13px] font-medium text-white outline-none transition-colors hover:bg-stone-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-stone-200"
              >
                <Plus className="size-3.5" weight="bold" />
                New
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="mx-3 mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 sm:mx-4">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <table className="w-full min-w-[52rem] table-fixed border-collapse text-left text-[13px] leading-none">
            <colgroup>
              <col className="w-10" />
              <col className="w-[7.5rem]" />
              <col />
              <col className="w-[7.5rem]" />
              <col className="w-[8.5rem]" />
              <col className="w-[9.5rem]" />
              <col className="w-[9.5rem]" />
              <col className="w-16" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-stone-50 dark:bg-[#0a0a0a]">
              <tr className="text-[13px] font-normal text-stone-500 dark:text-stone-400">
                <th className="h-10 border border-black/10 px-0 text-center font-normal dark:border-white/[0.08]">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && selected.size === filtered.length}
                    onChange={toggleAll}
                    className="size-3.5 rounded-[3px] border-stone-200 bg-transparent accent-stone-400 opacity-50 checked:opacity-100 dark:border-white/15 dark:accent-stone-500"
                    aria-label="Select all"
                  />
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Id
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Job
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Priority
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Status
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Place
                </th>
                <th className="h-10 border border-l-0 border-black/10 px-3 text-left font-normal dark:border-white/[0.08]">
                  Started
                </th>
                <th className="h-10 border border-l-0 border-black/10 dark:border-white/[0.08]" />
              </tr>
            </thead>
            <tbody>
              {draft ? (
                <tr className="bg-sky-50/40 dark:bg-sky-500/[0.06]">
                  <td
                    className={cn(
                      draftCell,
                      "border-l border-black/10 px-0 text-center dark:border-white/[0.08]",
                    )}
                  />
                  <td className={cn(draftCell, "text-stone-400")}>—</td>
                  <td className={cn(draftCell, "py-1")}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <input
                        autoFocus
                        value={draft.name}
                        onChange={e => setDraft({ ...draft, name: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void startDraft();
                          }
                          if (e.key === "Escape") setDraft(null);
                        }}
                        placeholder="Name (e.g. testing)"
                        className="h-7 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] font-medium text-stone-900 outline-none placeholder:font-normal focus:border-black/10 focus:bg-white dark:text-stone-100 dark:focus:border-white/15 dark:focus:bg-[#111]"
                      />
                      <input
                        value={draft.command}
                        onChange={e => setDraft({ ...draft, command: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void startDraft();
                          }
                          if (e.key === "Escape") setDraft(null);
                        }}
                        placeholder="Command…"
                        className="h-7 w-full rounded-md border border-transparent bg-transparent px-2 text-[12px] text-stone-600 outline-none focus:border-black/10 focus:bg-white dark:text-stone-300 dark:focus:border-white/15 dark:focus:bg-[#111]"
                      />
                    </div>
                  </td>
                  <td className={draftCell}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        onClick={e => e.stopPropagation()}
                      >
                        <span
                          className={cn("size-1.5 rounded-full", prioLabel(draft.priority).dot)}
                        />
                        {prioLabel(draft.priority).label}
                        <CaretDown className="size-3 opacity-50" weight="bold" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-36">
                        {PRIO_OPTS.map(p => (
                          <DropdownMenuItem
                            key={p.key}
                            onSelect={() => setDraft({ ...draft, priority: p.key })}
                          >
                            <span className={cn("size-1.5 rounded-full", p.dot)} />
                            {p.label}
                            {draft.priority === p.key ? (
                              <Check className="ml-auto size-3.5" weight="bold" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                  <td className={draftCell}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-stone-500 outline-none hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        onClick={e => e.stopPropagation()}
                      >
                        {draft.manage ? "Managed" : "Draft"}
                        <CaretDown className="size-3 opacity-50" weight="bold" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <DropdownMenuItem
                          onSelect={() => setDraft({ ...draft, manage: false })}
                        >
                          One-shot
                          {!draft.manage ? (
                            <Check className="ml-auto size-3.5" weight="bold" />
                          ) : null}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setDraft({ ...draft, manage: true })}
                        >
                          Auto-recover
                          {draft.manage ? (
                            <Check className="ml-auto size-3.5" weight="bold" />
                          ) : null}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>GPUs</DropdownMenuLabel>
                        {["", "1", "2", "4", "8"].map(n => (
                          <DropdownMenuItem
                            key={n || "any"}
                            onSelect={() => setDraft({ ...draft, gpu: n })}
                          >
                            {n ? `${n} GPU${n === "1" ? "" : "s"}` : "Auto"}
                            {draft.gpu === n ? (
                              <Check className="ml-auto size-3.5" weight="bold" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                  <td className={draftCell}>
                    <PlacePicker
                      places={places}
                      selected={draft.places}
                      onChange={names => setDraft({ ...draft, places: names })}
                      onPlacesChanged={() => void refreshPlaces()}
                      multi
                    />
                  </td>
                  <td className={cn(draftCell, "text-stone-400")}>Now</td>
                  <td className={cn(draftCell, "px-1")}>
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        disabled={creating}
                        onClick={() => void startDraft()}
                        className="inline-flex h-7 items-center rounded-md bg-stone-900 px-2 text-[11px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                      >
                        {creating ? (
                          <CircleNotch className="size-3 animate-spin" />
                        ) : (
                          "Run"
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraft(null)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-stone-400 hover:bg-black/5 hover:text-stone-700 dark:hover:bg-white/10"
                        aria-label="Cancel draft"
                      >
                        <X className="size-3.5" weight="bold" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : null}

              {loading && !jobs.length ? (
                <tr>
                  <td
                    colSpan={8}
                    className="h-24 border border-t-0 border-black/10 text-center text-stone-400 dark:border-white/[0.08]"
                  >
                    <CircleNotch className="mx-auto size-4 animate-spin" />
                  </td>
                </tr>
              ) : null}

              {!loading && !filtered.length && !draft ? (
                <tr>
                  <td
                    colSpan={8}
                    className="border border-t-0 border-black/10 px-4 py-10 text-center text-stone-500 dark:border-white/[0.08]"
                  >
                    <p className="text-stone-700 dark:text-stone-300">No jobs yet</p>
                    <p className="mt-1 text-[12px]">Press New to add a row and run on SSH.</p>
                  </td>
                </tr>
              ) : null}

              {filtered.map(job => {
                const st = statusMeta(job.status);
                const prio = priorityMeta(job);
                const open = detailId === job.id;
                return (
                  <tr
                    key={job.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={open}
                    onClick={() => openDetail(job.id)}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(job.id);
                      }
                    }}
                    className={cn(
                      "cursor-pointer text-stone-800 dark:text-stone-200",
                      open
                        ? "bg-black/[0.03] dark:bg-white/[0.05]"
                        : "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
                    )}
                  >
                    <td
                      className={cn(
                        cell,
                        "w-10 border-l border-black/10 px-0 text-center dark:border-white/[0.08]",
                      )}
                      onClick={e => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(job.id)}
                        onChange={() => toggleSelect(job.id)}
                        className="size-3.5 rounded-[3px] border-stone-200 bg-transparent accent-stone-400 opacity-50 checked:opacity-100 dark:border-white/15 dark:accent-stone-500"
                        aria-label={`Select ${job.id}`}
                      />
                    </td>
                    <td className={cn(cell, "font-mono text-[12px] text-stone-500")}>
                      <span className="block truncate">{job.id}</span>
                    </td>
                    <td className={cell}>
                      {job.tags?.name ? (
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="block truncate font-medium text-stone-900 dark:text-stone-100">
                            {job.tags.name}
                          </span>
                          <span className="block truncate text-[11px] text-stone-500 dark:text-stone-400">
                            {cmdLabel(job.command)}
                          </span>
                        </span>
                      ) : (
                        <span className="block truncate text-stone-900 dark:text-stone-100">
                          {job.tags?.sweep || cmdLabel(job.command)}
                        </span>
                      )}
                    </td>
                    <td className={cell}>
                      <span className="inline-flex max-w-full items-center gap-1.5">
                        <span className={cn("size-1.5 shrink-0 rounded-full", prio.dot)} />
                        <span className="truncate">{prio.label}</span>
                      </span>
                    </td>
                    <td className={cell}>
                      <span
                        className={cn(
                          "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium",
                          st.className,
                        )}
                      >
                        {st.label}
                        {job.code != null && job.status !== "running" ? ` · ${job.code}` : ""}
                      </span>
                    </td>
                    <td className={cn(cell, "text-stone-600 dark:text-stone-400")}>
                      <span className="block truncate">
                        {job.place}
                        {job.pool ? ` · ${job.pool}` : ""}
                      </span>
                    </td>
                    <td className={cn(cell, "text-stone-600 dark:text-stone-400")}>
                      <span className="block truncate">{formatStarted(job.started)}</span>
                    </td>
                    <td
                      className={cn(cell, "px-1 text-center text-stone-400")}
                      onClick={e => e.stopPropagation()}
                    >
                      {busyId === job.id ? (
                        <CircleNotch className="mx-auto size-3.5 animate-spin" />
                      ) : (
                        <span className="text-[12px]">{open ? "▸" : ""}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detailJob ? (
        <JobsDetailPanel
          job={detailJob}
          logs={logs}
          logsLoading={logsLoading}
          busy={busyId === detailJob.id}
          onClose={() => {
            setDetailId(null);
            setLogs("");
          }}
          onRefreshLogs={() => void loadLogs(detailJob.id)}
          onAction={args => void runAction(detailJob.id, args)}
        />
      ) : null}
    </div>
  );
}
