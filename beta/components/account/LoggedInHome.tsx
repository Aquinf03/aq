"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ArrowUpRight } from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";
import { createClient } from "@/lib/supabase/client";
import { firstName, timeGreeting } from "@/lib/greeting";
import { siteConfig } from "@/lib/config";

const INSTALL_CMD = "curl -fsSL https://aq.aquin.app/framework/install.sh | bash";

const NEXT_CMDS = [
  { id: "login", label: "Sign in", cmd: "aq login" },
  { id: "doctor", label: "Check your setup", cmd: "aq doctor" },
  { id: "init", label: "Start a train", cmd: "aq init my-train" },
] as const;

type CopyKey = "install" | (typeof NEXT_CMDS)[number]["id"];

function CmdRow({
  cmd,
  copied,
  onCopy,
}: {
  cmd: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-stretch gap-0 rounded-xl border-2 border-stone-200 dark:border-stone-700">
      <code className="flex-1 min-w-0 self-center overflow-x-auto whitespace-nowrap px-3.5 py-2.5 text-[13px] leading-relaxed text-stone-800 select-all no-scrollbar dark:text-stone-200">
        {cmd}
      </code>
      <div className="w-0.5 shrink-0 self-stretch bg-stone-200 dark:bg-stone-700" aria-hidden />
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${cmd}`}
        className="shrink-0 inline-flex items-center justify-center px-3 text-stone-500 hover:text-stone-800 transition-colors dark:text-stone-400 dark:hover:text-stone-100"
        onClick={onCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" weight="bold" />
        ) : (
          <Copy className="h-3.5 w-3.5" weight="bold" />
        )}
      </button>
    </div>
  );
}

/** Logged-in home body (install + next steps) shown at /{username}. */
export function LoggedInHome() {
  const { user } = useAuth();
  const supabase = createClient();
  const [profileName, setProfileName] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKey | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setProfileName(null);
      return;
    }
    void supabase
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => setProfileName(data?.name ?? null));
  }, [user?.id, supabase]);

  const copyText = async (which: CopyKey, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* select-all still works */
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-8">
      <h2 className="font-host-grotesk text-center text-2xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-stone-100">
        {timeGreeting()}, {firstName(profileName, user?.email ?? "")}
      </h2>

      <div className="font-roboto space-y-5 text-left">
        <div className="space-y-2">
          <p className="text-sm font-normal text-stone-500 dark:text-stone-400">Install the CLI</p>
          <CmdRow
            cmd={INSTALL_CMD}
            copied={copied === "install"}
            onCopy={() => void copyText("install", INSTALL_CMD)}
          />
        </div>

        {NEXT_CMDS.map(({ id, label, cmd }) => (
          <div key={id} className="space-y-2">
            <p className="text-sm font-normal text-stone-500 dark:text-stone-400">{label}</p>
            <CmdRow
              cmd={cmd}
              copied={copied === id}
              onCopy={() => void copyText(id, cmd)}
            />
          </div>
        ))}

        <div className="pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a
              href={siteConfig.links.docs}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-stone-800 underline decoration-stone-300 underline-offset-4 transition-colors hover:decoration-stone-800 dark:text-stone-200 dark:decoration-stone-600 dark:hover:decoration-stone-300"
            >
              Documentation
              <ArrowUpRight
                className="h-3.5 w-3.5 text-stone-400 transition-colors group-hover:text-stone-800 dark:text-stone-500 dark:group-hover:text-stone-200"
                weight="bold"
              />
            </a>
            <span className="text-stone-300 dark:text-stone-600" aria-hidden>
              ·
            </span>
            <a
              href="https://aquin.app/changelog"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-stone-800 underline decoration-stone-300 underline-offset-4 transition-colors hover:decoration-stone-800 dark:text-stone-200 dark:decoration-stone-600 dark:hover:decoration-stone-300"
            >
              Changelog
              <ArrowUpRight
                className="h-3.5 w-3.5 text-stone-400 transition-colors group-hover:text-stone-800 dark:text-stone-500 dark:group-hover:text-stone-200"
                weight="bold"
              />
            </a>
          </div>
          <p className="mt-1.5 text-xs text-stone-400 dark:text-stone-500">
            Guides, CLI reference, and how trains work. Release notes for each{" "}
            <span className="font-mono">aq</span> version.
          </p>
        </div>
      </div>
    </div>
  );
}
