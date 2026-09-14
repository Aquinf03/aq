"use client";

import { useEffect, useState } from "react";
import { CircleNotch, FolderSimple, X } from "@phosphor-icons/react";
import {
  desktopSshRequest,
  getDesktopApi,
  type SshConnectResult,
  type SshDirEntry,
} from "@/lib/desktop";
import { cn } from "@/lib/utils";

type Phase = "form" | "browse" | "busy";

type SshOpenFolderDialogProps = {
  open: boolean;
  onClose: () => void;
  onOpened?: (info: { connectionId: string; path: string; host: string }) => void;
};

export function SshOpenFolderDialog({ open, onClose, onOpened }: SshOpenFolderDialogProps) {
  const [phase, setPhase] = useState<Phase>("form");
  const [host, setHost] = useState("127.0.0.1");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("22");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [ignoreHostKey, setIgnoreHostKey] = useState(true);
  const [installAq, setInstallAq] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<SshConnectResult | null>(null);
  const [cwd, setCwd] = useState(".");
  const [entries, setEntries] = useState<SshDirEntry[]>([]);

  useEffect(() => {
    if (!open) {
      setPhase("form");
      setError(null);
      setConnection(null);
      setEntries([]);
      setPassword("");
    }
  }, [open]);

  if (!open) return null;

  const desktop = getDesktopApi();

  const connect = async () => {
    setError(null);
    setPhase("busy");
    try {
      if (!desktop) {
        throw new Error("Open this workspace in the Aquin desktop app to use SSH.");
      }
      const result = await desktopSshRequest<SshConnectResult>("ssh.connect", {
        host: host.trim(),
        username: username.trim(),
        port: Number(port) || 22,
        privateKeyPath: privateKeyPath.trim() || undefined,
        password: password || undefined,
        knownHosts: ignoreHostKey ? false : undefined,
      });
      setConnection(result);

      if (result.probe.needsBootstrap) {
        await desktopSshRequest("ssh.bootstrap", {
          connectionId: result.connectionId,
          installAq,
        });
      }

      const home = result.probe.home || ".";
      setCwd(home);
      const listing = await desktopSshRequest<{ path: string; entries: SshDirEntry[] }>(
        "ssh.listdir",
        { connectionId: result.connectionId, path: home },
      );
      setEntries(listing.entries);
      setPhase("browse");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
      setPhase("form");
    }
  };

  const openDir = async (path: string) => {
    if (!connection) return;
    setError(null);
    setPhase("busy");
    try {
      const listing = await desktopSshRequest<{ path: string; entries: SshDirEntry[] }>(
        "ssh.listdir",
        { connectionId: connection.connectionId, path },
      );
      setCwd(listing.path);
      setEntries(listing.entries);
      setPhase("browse");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to list directory");
      setPhase("browse");
    }
  };

  const chooseHere = () => {
    if (!connection) return;
    onOpened?.({
      connectionId: connection.connectionId,
      path: cwd,
      host: connection.host,
    });
    onClose();
  };

  const pickKey = async () => {
    const path = await desktop?.pickPrivateKey();
    if (path) setPrivateKeyPath(path);
  };

  const fieldClass =
    "w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-black/25 dark:border-white/10 dark:bg-black dark:text-[#f5f5f3]";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="SSH open folder"
        className="flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-black/10 bg-stone-50 shadow-xl dark:border-white/10 dark:bg-[#0a0a0a]"
      >
        <div className="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/10">
          <div className="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-[#f5f5f3]">
            <FolderSimple className="size-4" weight="regular" />
            SSH Open folder
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-black/5 hover:text-stone-800 dark:hover:bg-white/5 dark:hover:text-stone-200"
            aria-label="Close"
          >
            <X className="size-4" weight="bold" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!desktop ? (
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Desktop bridge missing. Restart the app with <code className="font-mono text-xs">npm start</code>.
            </p>
          ) : null}

          {error ? (
            <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}

          {phase === "form" || (phase === "busy" && !connection) ? (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">Host</span>
                <input className={fieldClass} value={host} onChange={e => setHost(e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Username</span>
                  <input
                    className={fieldClass}
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoComplete="username"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-stone-500">Port</span>
                  <input className={fieldClass} value={port} onChange={e => setPort(e.target.value)} />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">Private key path (optional if agent/password)</span>
                <div className="flex gap-2">
                  <input
                    className={fieldClass}
                    value={privateKeyPath}
                    onChange={e => setPrivateKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button
                    type="button"
                    onClick={() => void pickKey()}
                    className="shrink-0 rounded-lg border border-black/10 px-3 text-xs font-medium text-stone-700 hover:bg-black/5 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5"
                  >
                    Browse
                  </button>
                </div>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-stone-500">Password (optional)</span>
                <input
                  type="password"
                  className={fieldClass}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={ignoreHostKey}
                  onChange={e => setIgnoreHostKey(e.target.checked)}
                />
                Skip host key verification (dev only)
              </label>
              <label className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-300">
                <input type="checkbox" checked={installAq} onChange={e => setInstallAq(e.target.checked)} />
                Bootstrap: run framework install.sh on first connect
              </label>
            </div>
          ) : null}

          {(phase === "browse" || (phase === "busy" && connection)) && connection ? (
            <div className="space-y-3">
              <p className="truncate font-mono text-[11px] text-stone-500">
                {connection.username}@{connection.host}:{cwd}
              </p>
              <div className="max-h-72 overflow-y-auto rounded-xl border border-black/10 dark:border-white/10">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-black/5 px-3 py-2 text-left text-sm text-stone-600 hover:bg-black/[0.03] dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/[0.04]"
                  onClick={() => {
                    const parent = cwd.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
                    void openDir(parent || "/");
                  }}
                >
                  ..
                </button>
                {entries.map(entry => (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={!entry.isDir}
                    onClick={() => entry.isDir && void openDir(entry.path)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-black/5 px-3 py-2 text-left text-sm last:border-b-0 dark:border-white/10",
                      entry.isDir
                        ? "text-stone-800 hover:bg-black/[0.03] dark:text-[#f5f5f3] dark:hover:bg-white/[0.04]"
                        : "cursor-default text-stone-400 dark:text-stone-500",
                    )}
                  >
                    <FolderSimple
                      className="size-4 shrink-0 opacity-70"
                      weight={entry.isDir ? "regular" : "thin"}
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/5 px-4 py-3 dark:border-white/10">
          {phase === "busy" ? (
            <span className="mr-auto inline-flex items-center gap-2 text-xs text-stone-500">
              <CircleNotch className="size-3.5 animate-spin" weight="bold" />
              Working…
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-[#f5f5f3]"
          >
            Cancel
          </button>
          {phase === "form" ? (
            <button
              type="button"
              disabled={!username.trim() || !host.trim() || !desktop}
              onClick={() => void connect()}
              className="rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Connect
            </button>
          ) : null}
          {phase === "browse" ? (
            <button
              type="button"
              onClick={chooseHere}
              className="rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
            >
              Open this folder
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
