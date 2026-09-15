"use client";

import { useEffect, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { getDesktopApi } from "@/lib/desktop";
import {
  SIDEBAR_W,
  TITLEBAR_H,
  TOGGLE_BTN,
  TOGGLE_SLOT,
  TRAFFIC_LIGHT_PAD,
  trafficLightPosition,
  toggleTop,
} from "@/lib/titlebarChrome";
import { cn } from "@/lib/utils";

type WorkspaceShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  mainHeader?: React.ReactNode;
  className?: string;
};

function syncTrafficLights() {
  const api = getDesktopApi();
  if (!api?.setTrafficLightPosition) return;
  void api.setTrafficLightPosition(trafficLightPosition());
}

/** Left sidebar + inset rounded main (layout only). */
export function WorkspaceShell({ sidebar, children, mainHeader, className }: WorkspaceShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [peeking, setPeeking] = useState(false);

  useEffect(() => {
    syncTrafficLights();
    const t = window.setTimeout(syncTrafficLights, 50);
    return () => window.clearTimeout(t);
  }, []);

  const toggleBtnClass = cn(
    "aquin-no-drag inline-flex items-center justify-center rounded-md text-stone-500 outline-none",
    "transition-colors hover:bg-black/5 hover:text-stone-800",
    "dark:text-stone-400 dark:hover:bg-white/5 dark:hover:text-stone-200",
  );

  const expandSidebar = () => {
    setCollapsed(false);
    setPeeking(false);
  };

  const collapseSidebar = () => {
    setCollapsed(true);
    setPeeking(false);
  };

  /** Expanded: right edge of sidebar. Collapsed: just past traffic lights. */
  const toggleLeft = collapsed ? TRAFFIC_LIGHT_PAD : SIDEBAR_W - TOGGLE_SLOT;

  const sidebarBody = (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0" style={{ height: TITLEBAR_H }} aria-hidden />
      <div className="aquin-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
    </div>
  );

  return (
    <div className={cn("relative h-svh w-full overflow-hidden bg-stone-100 dark:bg-black", className)}>
      {/* Thin titlebar drag strip */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex"
        style={{ height: TITLEBAR_H }}
        aria-hidden
      >
        <div
          className="pointer-events-auto aquin-drag transition-[width] duration-300 ease-out"
          style={{ width: Math.max(0, toggleLeft) }}
        />
        <div className="pointer-events-none" style={{ width: TOGGLE_SLOT }} />
        <div className="pointer-events-auto aquin-drag min-w-0 flex-1" />
      </div>

      <div
        className="aquin-no-drag absolute z-50 flex items-center justify-center transition-[left] duration-300 ease-out"
        style={{
          left: toggleLeft,
          top: toggleTop(),
          width: TOGGLE_SLOT,
          height: TOGGLE_BTN,
        }}
      >
        <button
          type="button"
          onClick={collapsed ? expandSidebar : collapseSidebar}
          className={toggleBtnClass}
          style={{ width: TOGGLE_BTN, height: TOGGLE_BTN }}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <CaretLeft
              className={cn(
                "absolute size-3.5 transition-all duration-300 ease-out",
                collapsed ? "scale-75 opacity-0" : "scale-100 opacity-100",
              )}
              weight="bold"
            />
            <CaretRight
              className={cn(
                "absolute size-3.5 transition-all duration-300 ease-out",
                collapsed ? "scale-100 opacity-100" : "scale-75 opacity-0",
              )}
              weight="bold"
            />
          </span>
        </button>
      </div>

      <div className="flex h-full min-h-0 bg-stone-100 dark:bg-black">
        <aside
          className={cn(
            "flex shrink-0 flex-col overflow-hidden bg-stone-100 transition-[width] duration-300 ease-out dark:bg-black",
            collapsed ? "w-0" : "w-[240px]",
          )}
          aria-hidden={collapsed}
        >
          {!collapsed ? (
            <div className="flex h-full flex-col" style={{ width: SIDEBAR_W }}>
              {sidebarBody}
            </div>
          ) : null}
        </aside>

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-300 ease-out",
            collapsed ? "px-1 sm:px-1.5" : "pr-1 pl-0.5 sm:pr-1.5 sm:pl-1",
          )}
        >
          <div className="shrink-0" style={{ height: TITLEBAR_H }} aria-hidden />
          <main className="mb-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.35rem] border-2 border-black/10 bg-stone-50 dark:border-white/10 dark:bg-[#0a0a0a] sm:mb-1.5">
            {mainHeader ? (
              <div className="aquin-no-drag flex shrink-0 items-center justify-end gap-3 px-4 py-3 sm:px-5">
                {mainHeader}
              </div>
            ) : null}
            <div className="aquin-no-drag min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-2 sm:px-8 sm:pb-10 sm:pt-4">
              {children}
            </div>
          </main>
        </div>
      </div>

      {collapsed ? (
        <div
          className={cn(
            "absolute bottom-1 left-0 z-40 transition-[width] duration-300 ease-out sm:bottom-1.5",
            peeking ? "w-[240px]" : "w-3",
          )}
          style={{ top: TITLEBAR_H }}
          onMouseEnter={() => setPeeking(true)}
          onMouseLeave={() => setPeeking(false)}
        >
          <aside
            className={cn(
              "absolute inset-y-0 left-0 flex flex-col overflow-hidden rounded-l-none rounded-r-[1.35rem] border-2 border-l-0 border-black/10 bg-stone-100 shadow-lg transition-transform duration-300 ease-out dark:border-white/10 dark:bg-black",
              peeking ? "translate-x-0" : "-translate-x-full",
            )}
            style={{ width: SIDEBAR_W }}
          >
            {sidebarBody}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
