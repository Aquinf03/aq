"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

type PipInstallPillProps = {
  className?: string;
  size?: "sm" | "md";
  variant?: "docs" | "hero";
  fullWidth?: boolean;
};

const CMD = "curl -fsSL https://aq.aquin.app/framework/install.sh | bash";

export function PipInstallPill({
  className,
  size = "sm",
  variant = "docs",
  fullWidth = false,
}: PipInstallPillProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const isMd = size === "md";
  const isHero = variant === "hero";
  const iconSize = isMd ? "w-4 h-4" : "w-3.5 h-3.5";

  return (
    <div
      className={cn(
        "flex items-stretch border overflow-hidden font-mono text-stone-700",
        fullWidth
          ? "w-full rounded-2xl border-2 border-black/10 bg-transparent"
          : cn(
              "shrink-0 rounded-lg border bg-transparent",
              isHero ? "border-stone-300" : "border-stone-200",
            ),
        isMd ? "text-[14px]" : "text-[12px]",
        className,
      )}
    >
      <span
        className={cn(
          "flex items-center text-stone-400 select-none",
          isMd ? "pl-3.5 pr-2.5" : "pl-2.5 pr-2",
          !isHero && "border-r border-stone-200",
        )}
        aria-hidden
      >
        $
      </span>
      <span
        className={cn(
          "flex items-center whitespace-nowrap",
          isMd ? "pl-3 py-2.5" : "pl-2.5 py-2",
          fullWidth && "flex-1 min-w-0",
          isHero ? (isMd ? "pr-2" : "pr-1.5") : isMd ? "pr-4" : "pr-3",
        )}
      >
        <span className={cn(fullWidth && "truncate")}>{CMD}</span>
      </span>
      <button
        type="button"
        onClick={copy}
        className={cn(
          "flex items-center justify-center text-stone-400 hover:text-stone-700 transition-colors",
          fullWidth
            ? "px-3 hover:bg-stone-100"
            : isHero
              ? cn("hover:bg-black/5", isMd ? "pr-3.5 pl-1" : "pr-2.5 pl-0.5")
              : cn(
                  "border-l border-stone-200 hover:bg-stone-100",
                  isMd ? "px-3" : "px-2.5",
                ),
        )}
        aria-label="Copy aq install command"
      >
        {copied ? (
          <Check className={cn(iconSize, "text-emerald-500")} weight="bold" />
        ) : (
          <Copy className={iconSize} />
        )}
      </button>
      {isHero && (
        <Link
          href="/"
          className={cn(
            "flex items-center font-semibold transition-colors",
            fullWidth
              ? "border-l border-black/10 px-3.5 text-[13px] text-stone-600 hover:text-stone-900 hover:bg-stone-100"
              : cn(
                  "border-l border-stone-300 text-stone-800 hover:bg-black/5",
                  isMd ? "px-3.5 text-[13px]" : "px-3 text-[12px]",
                ),
          )}
          style={{ fontFamily: "inherit" }}
        >
          <span className="font-sans">Docs</span>
        </Link>
      )}
    </div>
  );
}

/** Single outlined strip: $ | curl | copy | Docs → | aq.aquin.app */
export function AqInstallStrip({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className={cn(
        "flex items-center w-full rounded-xl border-2 border-stone-600/10 bg-transparent overflow-hidden",
        className,
      )}
    >
      <span
        className="flex items-center self-stretch pl-4 pr-3 border-r border-stone-600/10 font-mono text-[13px] sm:text-[14px] text-stone-400 select-none"
        aria-hidden
      >
        $
      </span>
      <span className="flex-1 min-w-0 flex items-center px-3.5 py-3 font-mono text-[12px] sm:text-[13px] text-stone-700 truncate">
        {CMD}
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex items-center justify-center self-stretch px-3.5 border-l border-stone-600/10 text-stone-400 hover:text-stone-800 hover:bg-stone-100/70 transition-colors"
        aria-label="Copy aq install command"
      >
        {copied ? (
          <Check className="w-4 h-4 text-emerald-500" weight="bold" />
        ) : (
          <Copy className="w-4 h-4" />
        )}
      </button>
      <Link
        href="/"
        className="flex items-center gap-1.5 self-stretch px-4 border-l border-stone-600/10 font-sans text-[13px] sm:text-[14px] font-semibold text-stone-800 hover:bg-stone-100/70 transition-colors whitespace-nowrap"
      >
        Docs
        <ArrowRight className="w-3.5 h-3.5" weight="bold" />
      </Link>
      <div className="flex items-center self-stretch pl-2.5 pr-2.5 border-l border-stone-600/10">
        <Link
          href="/"
          className="inline-flex items-center h-8 sm:h-9 px-3.5 rounded-lg bg-stone-900 font-sans text-[12px] sm:text-[13px] font-semibold text-white hover:bg-stone-800 transition-colors whitespace-nowrap"
        >
          Login
        </Link>
      </div>
    </div>
  );
}
