"use client";

import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  Check,
  CircleNotch,
  ClockCountdown,
  Copy,
  FolderOpen,
  Prohibit,
  Star,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { FleetJobRow } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function statusMeta(status: string): {
  label: string;
  className: string;
  Icon: typeof Star;
} {
  const s = status.toLowerCase();
  if (s === "running") {
    return {
      label: "Running",
      className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300",
      Icon: Star,
    };
  }
  if (s === "exited") {
    return {
      label: "Completed",
      className: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
      Icon: Check,
    };
  }
  if (s === "canceled") {
    return {
      label: "Canceled",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
      Icon: Prohibit,
    };
  }
  if (s === "unreachable" || s === "error" || s === "missing") {
    return {
      label: s === "unreachable" ? "Unreachable" : s === "missing" ? "Missing" : "Error",
      className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
      Icon: Prohibit,
    };
  }
  return {
    label: status || "Unknown",
    className: "bg-stone-100 text-stone-700 dark:bg-white/10 dark:text-stone-300",
    Icon: ClockCountdown,
  };
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type JobsDetailPanelProps = {
  job: FleetJobRow;
  logs: string;
  logsLoading: boolean;
  busy: boolean;
  onClose: () => void;
  onRefreshLogs: () => void;
  onAction: (args: string[]) => void;
};

/** Right ~40% slide-over with job meta, actions, and logs. */
export function JobsDetailPanel({
  job,
  logs,
  logsLoading,
  busy,
  onClose,
  onRefreshLogs,
  onAction,
}: JobsDetailPanelProps) {
  const st = statusMeta(job.status);
  const StatusIcon = st.Icon;
  const title = job.tags?.name || job.tags?.sweep || job.command.join(" ") || job.id;
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [job.id]);

  return (
    <aside
      className={cn(
        "flex h-full w-[min(40%,28rem)] shrink-0 flex-col border-l border-black/10 bg-stone-50 transition-transform duration-300 ease-out dark:border-white/10 dark:bg-[#0a0a0a]",
        entered ? "translate-x-0" : "translate-x-4 opacity-0",
      )}
      aria-label={`Job ${job.id}`}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-black/10 px-4 py-3 dark:border-white/[0.08]">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-stone-900 dark:text-[#f5f5f3]">
            {title}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{job.id}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-black/10 px-2.5 text-[12px] font-medium text-stone-600 outline-none hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/[0.06]"
          >
            {busy ? <CircleNotch className="size-3.5 animate-spin" /> : null}
            Manage
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onAction(["jobs", "status", job.id])}>
              <FolderOpen />
              Refresh status
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction(["jobs", "pull", job.id])}>
              <Copy />
              Pull artifacts
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction(["jobs", "recover", job.id, "--json"])}>
              <ArrowClockwise />
              Recover
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onAction(["jobs", "down", job.id])}
            >
              <Trash />
              Stop job
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 outline-none hover:bg-black/[0.04] hover:text-stone-800 dark:hover:bg-white/[0.06] dark:hover:text-stone-200"
          aria-label="Close panel"
        >
          <X className="size-4" weight="bold" />
        </button>
      </div>

      <div className="shrink-0 space-y-3 border-b border-black/10 px-4 py-3 dark:border-white/[0.08]">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              st.className,
            )}
          >
            <StatusIcon className="size-3" weight="fill" />
            {st.label}
            {job.code != null && job.status !== "running" ? ` · ${job.code}` : ""}
          </span>
          {job.managed?.enabled ? (
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
              Managed
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          <dt className="text-stone-500">Place</dt>
          <dd className="truncate text-stone-800 dark:text-stone-200">
            {job.place}
            {job.pool ? ` · ${job.pool}` : ""}
          </dd>
          <dt className="text-stone-500">Started</dt>
          <dd className="text-stone-800 dark:text-stone-200">{formatWhen(job.started)}</dd>
          <dt className="text-stone-500">Ended</dt>
          <dd className="text-stone-800 dark:text-stone-200">{formatWhen(job.ended)}</dd>
          <dt className="text-stone-500">Command</dt>
          <dd className="break-all font-mono text-[11px] leading-relaxed text-stone-700 dark:text-stone-300">
            {job.command.join(" ") || "—"}
          </dd>
          {job.remoteDir ? (
            <>
              <dt className="text-stone-500">Remote</dt>
              <dd className="truncate font-mono text-[11px] text-stone-600 dark:text-stone-400">
                {job.remoteDir}
              </dd>
            </>
          ) : null}
          {job.gpuDevices?.length ? (
            <>
              <dt className="text-stone-500">GPUs</dt>
              <dd className="text-stone-800 dark:text-stone-200">{job.gpuDevices.join(", ")}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-4 py-2">
          <span className="text-[12px] font-medium text-stone-500">Logs</span>
          <button
            type="button"
            onClick={onRefreshLogs}
            disabled={logsLoading}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-stone-500 outline-none hover:bg-black/[0.04] hover:text-stone-800 disabled:opacity-50 dark:hover:bg-white/[0.06] dark:hover:text-stone-200"
          >
            <ArrowClockwise className={cn("size-3", logsLoading && "animate-spin")} />
            Refresh
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-4 pb-4 font-mono text-[11px] leading-relaxed text-stone-700 dark:text-stone-300">
          {logsLoading && !logs ? "Loading…" : logs || "(empty)"}
        </pre>
      </div>
    </aside>
  );
}
