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
  /** Pill tabs in the titlebar — sit flush after the toggle when collapsed. */
  tabBar?: React.ReactNode;
  mainHeader?: React.ReactNode;
  /** When false, main body does not scroll (child manages overflow). Default true. */
  mainScroll?: boolean;
  /** When false, no padding around main children (full-bleed tables). Default true. */
  mainPad?: boolean;
  className?: string;
};

function syncTrafficLights() {
  const api = getDesktopApi();
  if (!api?.setTrafficLightPosition) return;
  void api.setTrafficLightPosition(trafficLightPosition());
}

/** Left sidebar + inset rounded main (layout only). */
export function WorkspaceShell({
  sidebar,
  children,
  tabBar,
  mainHeader,
  mainScroll = true,
  mainPad = true,
  className,
}: WorkspaceShellProps) {
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
  /** Tabs slam right after the toggle. */
  const tabsLeft = toggleLeft + TOGGLE_SLOT;

  const sidebarBody = (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0" style={{ height: TITLEBAR_H }} aria-hidden />
      <div className="aquin-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
    </div>
  );

  return (
    <div className={cn("relative h-svh w-full overflow-hidden bg-stone-100 dark:bg-black", className)}>
      {/* Drag: left of toggle + thin strip on the far right */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex"
        style={{ height: TITLEBAR_H }}
        aria-hidden
      >
        <div
          className="pointer-events-auto aquin-drag transition-[width] duration-300 ease-out"
          style={{ width: Math.max(0, toggleLeft) }}
        />
        <div className="pointer-events-none shrink-0" style={{ width: TOGGLE_SLOT }} />
        <div className="min-w-0 flex-1" />
        <div className="pointer-events-auto aquin-drag w-10 shrink-0 sm:w-14" />
      </div>

      {/* Sidebar toggle — above tabs */}
      <div
        className="aquin-no-drag absolute z-[70] flex items-center justify-center transition-[left] duration-300 ease-out"
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

      {/* Top tabs — track toggle; when sidebar closes they slam next to it */}
      {tabBar ? (
        <div
          className="aquin-no-drag absolute z-[55] flex min-w-0 items-end overflow-hidden pt-[5px] transition-[left,right] duration-300 ease-out"
          style={{
            left: tabsLeft,
            right: 40,
            top: 0,
            height: TITLEBAR_H + 2,
          }}
        >
          {tabBar}
        </div>
      ) : null}

      <div className="relative z-0 flex h-full min-h-0 bg-stone-100 dark:bg-black">
        <aside
          className={cn(
            "relative z-[60] flex shrink-0 flex-col overflow-hidden bg-stone-100 transition-[width] duration-300 ease-out dark:bg-black",
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
            "relative z-0 flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-300 ease-out",
            collapsed ? "px-1 sm:px-1.5" : "pr-1 pl-0.5 sm:pr-1.5 sm:pl-1",
          )}
        >
          <div
            className="shrink-0"
            style={{ height: tabBar ? TITLEBAR_H + 2 : TITLEBAR_H }}
            aria-hidden
          />
          <main className="mb-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.35rem] border-2 border-black/10 bg-stone-50 dark:border-white/10 dark:bg-[#0a0a0a] sm:mb-1.5">
            {mainHeader ? (
              <div className="aquin-no-drag flex shrink-0 items-center justify-end gap-3 px-4 py-3 sm:px-5">
                {mainHeader}
              </div>
            ) : null}
            <div
              className={cn(
                "aquin-no-drag flex min-h-0 flex-1 flex-col",
                mainPad ? "px-4 pb-6 pt-2 sm:px-8 sm:pb-8 sm:pt-4" : "p-0",
                mainScroll ? "overflow-y-auto" : "overflow-hidden",
              )}
            >
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Peek sidebar — highest chrome above content, under toggle */}
      {collapsed ? (
        <div
          className={cn(
            "absolute bottom-1 left-0 z-[65] transition-[width] duration-300 ease-out sm:bottom-1.5",
            peeking ? "w-[240px] max-w-[85vw]" : "w-3",
          )}
          style={{ top: TITLEBAR_H }}
          onMouseEnter={() => setPeeking(true)}
          onMouseLeave={() => setPeeking(false)}
        >
          <aside
            className={cn(
              "absolute inset-y-0 left-0 flex w-[240px] max-w-[85vw] flex-col overflow-hidden rounded-l-none rounded-r-[1.35rem] border-2 border-l-0 border-black/10 bg-stone-100 shadow-lg transition-transform duration-300 ease-out dark:border-white/10 dark:bg-black",
              peeking ? "translate-x-0" : "-translate-x-full",
            )}
          >
            {sidebarBody}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
