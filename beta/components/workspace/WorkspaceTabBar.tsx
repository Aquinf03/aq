"use client";

import type { ReactNode } from "react";
import { FlyingSaucer, Plus, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type WorkspaceTabItem = {
  id: string;
  label: string;
  icon: ReactNode;
  closable?: boolean;
};

type WorkspaceTabBarProps = {
  tabs: WorkspaceTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab?: () => void;
  onAgent?: () => void;
};

/** Pill tabs in the titlebar (browser-like). Agent pinned to the right. */
export function WorkspaceTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
  onAgent,
}: WorkspaceTabBarProps) {
  return (
    <div className="aquin-no-drag flex h-full min-w-0 flex-1 items-end gap-2 px-0.5 pb-1.5 pt-0.5">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:gap-1.5">
        {tabs.map(tab => {
          const active = tab.id === activeId;
          const closable = tab.closable !== false;
          return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex h-7 max-w-[9.5rem] shrink-0 items-center gap-1 rounded-lg pl-2 text-[12px] font-medium transition-colors sm:max-w-[180px] sm:gap-1.5 sm:pl-2.5 sm:text-[12.5px]",
                closable ? "pr-0.5 sm:pr-1" : "pr-2 sm:pr-2.5",
                active
                  ? "bg-black/[0.08] text-stone-900 dark:bg-white/[0.12] dark:text-[#f5f5f3]"
                  : "bg-black/[0.04] text-stone-600 hover:bg-black/[0.07] hover:text-stone-800 dark:bg-white/[0.06] dark:text-stone-400 dark:hover:bg-white/[0.09] dark:hover:text-stone-200",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1 outline-none sm:gap-1.5"
              >
                <span className="shrink-0 opacity-80">{tab.icon}</span>
                <span className="truncate">{tab.label}</span>
              </button>
              {closable ? (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-stone-500 outline-none transition-opacity hover:bg-black/10 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100",
                    active
                      ? "opacity-70 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-70 group-hover:hover:opacity-100",
                  )}
                  aria-label={`Close ${tab.label}`}
                >
                  <X className="size-3" weight="bold" />
                </button>
              ) : null}
            </div>
          );
        })}
        {onNewTab ? (
          <button
            type="button"
            onClick={onNewTab}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-stone-500 outline-none transition-colors hover:bg-black/[0.06] hover:text-stone-800 dark:text-stone-400 dark:hover:bg-white/[0.08] dark:hover:text-stone-200"
            aria-label="New tab"
          >
            <Plus className="size-3.5" weight="bold" />
          </button>
        ) : null}
      </div>

      {onAgent ? (
        <button
          type="button"
          onClick={onAgent}
          className={cn(
            "mb-0 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium outline-none transition-colors sm:text-[12.5px]",
            "bg-black/[0.05] text-stone-700 hover:bg-black/[0.08] hover:text-stone-900",
            "dark:bg-white/[0.08] dark:text-stone-200 dark:hover:bg-white/[0.12] dark:hover:text-[#f5f5f3]",
          )}
        >
          <FlyingSaucer className="size-3.5 shrink-0 opacity-80" weight="regular" />
          Agent
        </button>
      ) : null}
    </div>
  );
}
