"use client";

import { useEffect, useState } from "react";
import { House, SquaresFour } from "@phosphor-icons/react";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { JobsManager } from "@/components/workspace/JobsManager";
import { SshOpenFolderDialog } from "@/components/workspace/SshOpenFolderDialog";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { WorkspaceTabBar } from "@/components/workspace/WorkspaceTabBar";
import { useAuth } from "@/contexts/AuthContext";
import { firstName, timeGreeting } from "@/lib/greeting";
import { cn } from "@/lib/utils";
import {
  loadWorkspaceTabs,
  nextTabId,
  saveWorkspaceTabs,
  type WorkspaceOpenTab,
  type WorkspaceTabKind,
} from "@/lib/workspaceTabs";

type WorkspaceHomeProps = {
  children?: React.ReactNode;
  displayName?: string;
};

const navBtn =
  "aquin-no-drag flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium outline-none transition-colors text-stone-600 opacity-90 hover:bg-black/[0.04] hover:text-stone-900 hover:opacity-100 dark:text-stone-300 dark:opacity-80 dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f3] dark:hover:opacity-100";

const TAB_META: Record<
  WorkspaceTabKind,
  { label: string; icon: React.ReactNode }
> = {
  home: {
    label: "Home",
    icon: <House className="size-3.5 shrink-0" weight="regular" />,
  },
  jobs: {
    label: "Jobs",
    icon: <SquaresFour className="size-3.5 shrink-0" weight="regular" />,
  },
};

/** Owner home: sidebar opens tabs; tab bar state persisted in localStorage. */
export function WorkspaceHome({ children, displayName }: WorkspaceHomeProps) {
  const { user } = useAuth();
  const [hydrated, setHydrated] = useState(false);
  const [tabs, setTabs] = useState<WorkspaceOpenTab[]>([{ id: "home-1", kind: "home" }]);
  const [activeId, setActiveId] = useState("home-1");
  const [seq, setSeq] = useState(2);
  const [sshOpen, setSshOpen] = useState(false);
  const [openedFolder, setOpenedFolder] = useState<{
    connectionId: string;
    path: string;
    host: string;
  } | null>(null);

  useEffect(() => {
    const stored = loadWorkspaceTabs();
    setTabs(stored.tabs);
    setActiveId(stored.activeId);
    setSeq(stored.seq);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveWorkspaceTabs({ tabs, activeId, seq });
  }, [tabs, activeId, seq, hydrated]);

  const name = firstName(displayName, user?.email ?? "");
  const greeting = `${timeGreeting()}, ${name}`;
  const active = tabs.find(t => t.id === activeId) ?? tabs[0] ?? null;

  const openOrFocus = (kind: WorkspaceTabKind) => {
    const existing = tabs.find(t => t.kind === kind);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = nextTabId(kind, seq);
    setSeq(n => n + 1);
    setTabs(prev => [...prev, { id, kind }]);
    setActiveId(id);
  };

  const openNewHome = () => {
    const id = nextTabId("home", seq);
    setSeq(n => n + 1);
    setTabs(prev => [...prev, { id, kind: "home" }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex(t => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter(t => t.id !== id);
      setActiveId(cur => {
        if (cur !== id) return cur;
        return (next[Math.max(0, idx - 1)] ?? next[0]).id;
      });
      return next;
    });
  };

  const selectTab = (id: string) => {
    if (tabs.some(t => t.id === id)) setActiveId(id);
  };

  const hasJobsTab = tabs.some(t => t.kind === "jobs");

  const main = children ?? (
    <>
      <div className={cn("h-full", active?.kind === "home" ? "flex" : "hidden")}>
        <div className="flex h-full w-full items-center justify-center px-6">
          <p className="font-host-grotesk text-center text-3xl font-medium tracking-[-0.03em] text-stone-800 dark:text-[#f5f5f3]">
            {greeting}
          </p>
        </div>
      </div>
      {hasJobsTab ? (
        <div className={cn("h-full", active?.kind === "jobs" ? "block" : "hidden")}>
          <JobsManager onConnectSsh={() => setSshOpen(true)} openedFolder={openedFolder} />
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <WorkspaceShell
        mainScroll={false}
        mainPad={false}
        tabBar={
          <WorkspaceTabBar
            tabs={tabs.map(t => ({
              id: t.id,
              label: TAB_META[t.kind].label,
              icon: TAB_META[t.kind].icon,
            }))}
            activeId={active?.id ?? ""}
            onSelect={selectTab}
            onClose={closeTab}
            onNewTab={openNewHome}
          />
        }
        sidebar={
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1">
              <div className="flex flex-col items-stretch gap-3">
                <div className="flex flex-col items-stretch gap-0.5">
                  <button type="button" onClick={() => openOrFocus("home")} className={navBtn}>
                    <House className="size-[18px] shrink-0" weight="regular" />
                    Home
                  </button>

                  <CliTokenDropdown />

                  <button type="button" onClick={() => openOrFocus("jobs")} className={navBtn}>
                    <SquaresFour className="size-[18px] shrink-0" weight="regular" />
                    Jobs
                  </button>

                  {openedFolder ? (
                    <p
                      className="truncate px-3 text-[10px] text-stone-400"
                      title={openedFolder.path}
                    >
                      {openedFolder.host}:{openedFolder.path}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-auto">
                <ProfileChip variant="sidebar" />
              </div>
            </div>
          </div>
        }
      >
        {main}
      </WorkspaceShell>

      <SshOpenFolderDialog
        open={sshOpen}
        onClose={() => setSshOpen(false)}
        onOpened={info => setOpenedFolder(info)}
      />
    </>
  );
}
