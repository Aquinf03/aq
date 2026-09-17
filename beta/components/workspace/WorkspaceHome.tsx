"use client";

import { useId, useState } from "react";
import { House, SquaresFour } from "@phosphor-icons/react";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { JobsManager } from "@/components/workspace/JobsManager";
import { SshOpenFolderDialog } from "@/components/workspace/SshOpenFolderDialog";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { WorkspaceTabBar } from "@/components/workspace/WorkspaceTabBar";
import { useAuth } from "@/contexts/AuthContext";
import { firstName, timeGreeting } from "@/lib/greeting";

type TabKind = "home" | "jobs";

type OpenTab = {
  id: string;
  kind: TabKind;
};

type WorkspaceHomeProps = {
  children?: React.ReactNode;
  displayName?: string;
};

const navBtn =
  "aquin-no-drag flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium outline-none transition-colors text-stone-600 opacity-90 hover:bg-black/[0.04] hover:text-stone-900 hover:opacity-100 dark:text-stone-300 dark:opacity-80 dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f3] dark:hover:opacity-100";

const TAB_META: Record<
  TabKind,
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

function newTabId(kind: TabKind, suffix: string) {
  return `${kind}-${suffix}`;
}

/** Owner home: sidebar opens tabs in the top bar above the main segment. */
export function WorkspaceHome({ children, displayName }: WorkspaceHomeProps) {
  const { user } = useAuth();
  const idPrefix = useId();
  const [seq, setSeq] = useState(1);
  const [tabs, setTabs] = useState<OpenTab[]>(() => [
    { id: newTabId("home", `${idPrefix}-0`), kind: "home" },
  ]);
  const [activeId, setActiveId] = useState(() => newTabId("home", `${idPrefix}-0`));
  const [sshOpen, setSshOpen] = useState(false);
  const [openedFolder, setOpenedFolder] = useState<{
    connectionId: string;
    path: string;
    host: string;
  } | null>(null);

  const name = firstName(displayName, user?.email ?? "");
  const greeting = `${timeGreeting()}, ${name}`;
  const active = tabs.find(t => t.id === activeId) ?? tabs[0] ?? null;

  const openOrFocus = (kind: TabKind) => {
    const existing = tabs.find(t => t.kind === kind);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = newTabId(kind, `${idPrefix}-${seq}`);
    setSeq(n => n + 1);
    setTabs(prev => [...prev, { id, kind }]);
    setActiveId(id);
  };

  const openNewHome = () => {
    const id = newTabId("home", `${idPrefix}-${seq}`);
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
      if (activeId === id) {
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveId(fallback.id);
      }
      return next;
    });
  };

  const main =
    children ??
    (active?.kind === "home" ? (
      <div className="flex h-full items-center justify-center px-6">
        <p className="font-host-grotesk text-center text-3xl font-medium tracking-[-0.03em] text-stone-800 dark:text-[#f5f5f3]">
          {greeting}
        </p>
      </div>
    ) : active?.kind === "jobs" ? (
      <JobsManager onConnectSsh={() => setSshOpen(true)} openedFolder={openedFolder} />
    ) : null);

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
            onSelect={setActiveId}
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
