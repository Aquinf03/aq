"use client";

import { useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

type WorkspaceShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  mainHeader?: React.ReactNode;
  className?: string;
};

/** Left sidebar + inset rounded main (layout only). */
export function WorkspaceShell({ sidebar, children, mainHeader, className }: WorkspaceShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [peeking, setPeeking] = useState(false);

  const toggleBtnClass =
    "inline-flex size-8 items-center justify-center rounded-md text-stone-500 outline-none transition-colors hover:bg-black/5 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-white/5 dark:hover:text-stone-200";

  const expandSidebar = () => {
    setCollapsed(false);
    setPeeking(false);
  };

  const collapseSidebar = () => {
    setCollapsed(true);
    setPeeking(false);
  };

  const sidebarBody = (
    <div className="relative flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={collapsed ? expandSidebar : collapseSidebar}
        className={cn(toggleBtnClass, "absolute right-3 top-3 z-10")}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <CaretRight className="size-4" weight="bold" />
        ) : (
          <CaretLeft className="size-4" weight="bold" />
        )}
      </button>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
    </div>
  );

  return (
    <div className={cn("relative h-svh w-full overflow-hidden bg-stone-100 dark:bg-black", className)}>
      <div className="flex h-full min-h-0 bg-stone-100 dark:bg-black">
        <aside
          className={cn(
            "flex shrink-0 flex-col overflow-hidden bg-stone-100 transition-[width] duration-300 ease-out dark:bg-black",
            collapsed ? "w-0" : "w-[240px]",
          )}
          aria-hidden={collapsed}
        >
          {!collapsed ? <div className="flex h-full w-[240px] flex-col">{sidebarBody}</div> : null}
        </aside>

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-300 ease-out",
            collapsed ? "px-1 sm:px-1.5" : "pr-1 pl-0.5 sm:pr-1.5 sm:pl-1",
          )}
        >
          <div className="flex h-[22px] shrink-0 items-center sm:h-[30px]">
            {collapsed ? (
              <button
                type="button"
                onClick={expandSidebar}
                className={toggleBtnClass}
                aria-label="Expand sidebar"
              >
                <CaretRight className="size-4" weight="bold" />
              </button>
            ) : null}
          </div>
          <main className="mb-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.35rem] border-2 border-black/10 bg-stone-50 dark:border-white/10 dark:bg-[#0a0a0a] sm:mb-1.5">
            {mainHeader ? (
              <div className="flex shrink-0 items-center justify-end gap-3 px-4 py-3 sm:px-5">
                {mainHeader}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-2 sm:px-8 sm:pb-10 sm:pt-4">
              {children}
            </div>
          </main>
        </div>
      </div>

      {collapsed ? (
        <div
          className={cn(
            "absolute z-40 flex transition-[width] duration-300 ease-out",
            "top-[22px] bottom-1 left-0 sm:top-[30px] sm:bottom-1.5",
            peeking ? "w-[calc(0.25rem+240px)] sm:w-[calc(0.375rem+240px)]" : "w-3",
          )}
          onMouseEnter={() => setPeeking(true)}
          onMouseLeave={() => setPeeking(false)}
        >
          <div className="w-3 shrink-0" aria-hidden />
          <aside
            className={cn(
              "flex h-full w-[240px] flex-col overflow-hidden rounded-[1.35rem] border-2 border-black/10 bg-stone-100 shadow-lg transition-transform duration-300 ease-out dark:border-white/10 dark:bg-black",
              peeking ? "translate-x-0" : "-translate-x-[calc(100%+0.75rem)]",
            )}
          >
            {sidebarBody}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
