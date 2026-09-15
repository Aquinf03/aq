"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Check, CircleNotch, Copy, Key } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { morphMenuContentClass, morphMenuTriggerClass } from "@/lib/morphMenu";
import { cn } from "@/lib/utils";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string | null;
  created_at: string;
  last_used_at?: string | null;
  revoked: boolean;
  revealable?: boolean;
}

const REVEAL_TTL_MS = 60_000;

function useCliToken(enabled: boolean) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showRevealForm, setShowRevealForm] = useState(false);
  const [password, setPassword] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateWarning, setGenerateWarning] = useState<string | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevealTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideRevealedKey = useCallback(() => {
    clearRevealTimer();
    setRevealedKey(null);
    setShowRevealForm(false);
    setPassword("");
    setRevealError(null);
  }, [clearRevealTimer]);

  const scheduleHideRevealed = useCallback(() => {
    clearRevealTimer();
    hideTimerRef.current = setTimeout(() => {
      setRevealedKey(null);
      hideTimerRef.current = null;
    }, REVEAL_TTL_MS);
  }, [clearRevealTimer]);

  useEffect(() => () => clearRevealTimer(), [clearRevealTimer]);

  const fetchKeys = useCallback(async () => {
    setFetchError(null);
    const res = await fetch("/api/keys");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFetchError(typeof data.error === "string" ? data.error : "Could not load CLI token.");
      setKeys([]);
      setLoading(false);
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    setKeys(rows.filter((k: ApiKey) => !k.revoked));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void fetchKeys();
  }, [fetchKeys, enabled]);

  async function generateToken() {
    if (
      keys.length > 0 &&
      !window.confirm(
        "Regenerate your CLI token? The old token stops working immediately on all machines using this account.",
      )
    ) {
      return;
    }
    hideRevealedKey();
    setGenerating(true);
    setGenerateError(null);
    setGenerateWarning(null);
    setNewKey(null);

    const res = await fetch("/api/keys/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CLI token" }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setGenerateError(typeof data.error === "string" ? data.error : "Could not generate token.");
      setGenerating(false);
      return;
    }

    if (typeof data.key === "string" && data.key) {
      setNewKey(data.key);
    } else {
      setGenerateError("Server did not return a token. Try again.");
    }
    if (typeof data.cipher_warning === "string") {
      setGenerateWarning(data.cipher_warning);
    }
    await fetchKeys();
    setGenerating(false);
  }

  async function revealToken(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) {
      setRevealError("Enter your account password.");
      return;
    }
    setRevealing(true);
    setRevealError(null);
    const res = await fetch("/api/keys/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRevealError(data.error ?? "Could not reveal token.");
      setRevealing(false);
      return;
    }
    setNewKey(null);
    setGenerateWarning(null);
    setRevealedKey(data.key);
    setPassword("");
    setShowRevealForm(false);
    scheduleHideRevealed();
    setRevealing(false);
  }

  function copyKey(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return {
    keys,
    loading,
    newKey,
    revealedKey,
    generating,
    copied,
    showRevealForm,
    password,
    revealing,
    revealError,
    fetchError,
    generateError,
    generateWarning,
    setNewKey,
    setPassword,
    setRevealError,
    setShowRevealForm,
    hideRevealedKey,
    generateToken,
    revealToken,
    copyKey,
  };
}

function CliTokenPanel({
  keys,
  loading,
  newKey,
  revealedKey,
  generating,
  copied,
  showRevealForm,
  password,
  revealing,
  revealError,
  fetchError,
  generateError,
  generateWarning,
  setNewKey,
  setPassword,
  setRevealError,
  setShowRevealForm,
  hideRevealedKey,
  generateToken,
  revealToken,
  copyKey,
}: ReturnType<typeof useCliToken>) {
  const active = keys[0];
  const visibleKey = newKey ?? revealedKey;

  return (
    <div data-setting-id="cli-token" className="py-1">
      {fetchError ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[10px] text-red-700">
          {fetchError}
        </div>
      ) : null}

      {generateError ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[10px] text-red-700">
          {generateError}
        </div>
      ) : null}

      {generateWarning ? (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800">
          {generateWarning}
        </div>
      ) : null}

      {visibleKey && (
        <div
          className={`mb-3 rounded-xl px-3 py-2 border ${
            newKey ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"
          }`}
        >
          <p
            className={`text-[9px] font-semibold mb-1 ${
              newKey ? "text-emerald-700" : "text-amber-800"
            }`}
          >
            {newKey ? "Your CLI token - copy for aquin login" : "Token visible for 60s - copy now"}
          </p>
          <div className="flex items-center gap-1.5">
            <code
              className={`flex-1 text-[10px] font-mono break-all ${
                newKey ? "text-emerald-800" : "text-amber-900"
              }`}
            >
              {visibleKey}
            </code>
            <button
              type="button"
              onClick={() => copyKey(visibleKey)}
              className={`shrink-0 transition-colors ${
                newKey ? "text-emerald-600 hover:text-emerald-800" : "text-amber-700 hover:text-amber-900"
              }`}
            >
              {copied ? <Check className="size-3" weight="bold" /> : <Copy className="size-3" weight="bold" />}
            </button>
          </div>
          {newKey ? (
            <p className="mt-1.5 text-[9px] text-emerald-600">
              On your GPU: <code className="font-mono">aquin login</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => (newKey ? setNewKey(null) : hideRevealedKey())}
            className={`mt-1.5 text-[9px] ${
              newKey ? "text-emerald-500 hover:text-emerald-700" : "text-amber-600 hover:text-amber-800"
            }`}
          >
            Hide
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-[10px] text-stone-300 py-1">Loading…</p>
      ) : active ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] text-stone-600 min-w-0 truncate">
              Active: <code className="font-mono text-stone-800">{active.key_prefix}…</code>
            </p>
            <button
              type="button"
              onClick={() => void generateToken()}
              disabled={generating}
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-stone-500 hover:text-stone-800 disabled:opacity-40 transition-colors"
            >
              {generating ? <CircleNotch className="size-3 animate-spin" weight="bold" /> : <ArrowsClockwise className="size-3" weight="bold" />}
              Regenerate
            </button>
          </div>
          <p className="text-[9px] text-stone-400">
            Created {new Date(active.created_at).toLocaleDateString()}
            {active.last_used_at
              ? ` · Last used ${new Date(active.last_used_at).toLocaleDateString()}`
              : ""}
          </p>
          {active.revealable === false ? null : showRevealForm ? (
            <form onSubmit={revealToken} className="pt-1 space-y-2">
              <label className="block text-[9px] font-medium text-stone-500">Account password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter password to show token"
                className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[11px] text-stone-800 placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-300/60"
              />
              {revealError ? <p className="text-[9px] text-red-600">{revealError}</p> : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={revealing}
                  className="inline-flex items-center gap-1 rounded-lg bg-black px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-black/90 disabled:opacity-50"
                >
                  {revealing ? <CircleNotch className="size-3 animate-spin" weight="bold" /> : <Key className="size-3" weight="bold" />}
                  Show token
                </button>
                <button
                  type="button"
                  onClick={hideRevealedKey}
                  className="text-[10px] text-stone-500 hover:text-stone-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRevealError(null);
                setShowRevealForm(true);
              }}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-stone-600 hover:text-stone-900"
            >
              <Copy className="size-3" weight="bold" />
              Copy token
            </button>
          )}
          <p className="text-[10px] text-stone-400 leading-relaxed pt-0.5">
            One active token per account. Copy again anytime with your password, or regenerate to rotate.
          </p>
        </div>
      ) : !visibleKey ? (
        <div className="rounded-xl border border-dashed border-stone-200 bg-white/50 px-3 py-3 space-y-2">
          <p className="text-[10px] text-stone-500">
            No token yet. Generate one, then run <code className="font-mono">aquin login</code> on your GPU.
          </p>
          <button
            type="button"
            onClick={() => void generateToken()}
            disabled={generating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-black px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-black/90 disabled:opacity-50 transition-colors"
          >
            {generating ? <CircleNotch className="size-3.5 animate-spin" weight="bold" /> : <Key className="size-3.5" weight="bold" />}
            {generating ? "Generating…" : "Generate CLI token"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CliTokenDropdown() {
  const cli = useCliToken(true);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={morphMenuTriggerClass()}>
        <Key className="size-[18px] shrink-0" weight="regular" />
        aq-token
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={0}
        className={cn(morphMenuContentClass(), "p-3")}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <CliTokenPanel {...cli} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function CliTokenSection({ hidden }: { hidden?: boolean }) {
  const cli = useCliToken(!hidden);
  if (hidden) return null;
  return <CliTokenPanel {...cli} />;
}
