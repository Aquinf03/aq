"use client";

import { useState } from "react";
import { ArrowUpRight, FolderSimple } from "@phosphor-icons/react";
import { AquinBrand } from "@/components/ui/AquinBrand";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { SshOpenFolderDialog } from "@/components/workspace/SshOpenFolderDialog";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { siteConfig } from "@/lib/config";

type WorkspaceHomeProps = {
  children: React.ReactNode;
};

const linkClass =
  "group inline-flex items-center gap-1.5 text-sm font-medium text-stone-600 transition-colors hover:text-stone-900 dark:text-stone-300 dark:hover:text-[#f5f5f3]";

const actionClass =
  "inline-flex items-center gap-2 text-sm font-medium text-stone-600 transition-colors hover:text-stone-900 dark:text-stone-300 dark:hover:text-[#f5f5f3]";

/** Owner home chrome: brand + aq-token + docs top, profile bottom in sidebar. */
export function WorkspaceHome({ children }: WorkspaceHomeProps) {
  const [sshOpen, setSshOpen] = useState(false);
  const [openedFolder, setOpenedFolder] = useState<{
    connectionId: string;
    path: string;
    host: string;
  } | null>(null);

  return (
    <>
      <WorkspaceShell
        sidebar={
          <div className="flex h-full flex-col px-4 pb-3 pt-4">
            <div className="flex flex-col items-stretch gap-3">
              <div className="flex items-center pr-9">
                <AquinBrand size="sm" href="/" />
              </div>
              <div className="flex flex-col items-stretch gap-2 pt-2">
                <CliTokenDropdown />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <a
                    href={siteConfig.links.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    Documentation
                    <ArrowUpRight
                      className="h-3.5 w-3.5 text-stone-400 transition-colors group-hover:text-stone-800 dark:text-stone-500 dark:group-hover:text-[#f5f5f3]"
                      weight="bold"
                    />
                  </a>
                  <span className="text-stone-300 dark:text-white/20" aria-hidden>
                    ·
                  </span>
                  <a href={siteConfig.links.changelog} className={linkClass}>
                    Changelog
                    <ArrowUpRight
                      className="h-3.5 w-3.5 text-stone-400 transition-colors group-hover:text-stone-800 dark:text-stone-500 dark:group-hover:text-[#f5f5f3]"
                      weight="bold"
                    />
                  </a>
                </div>
                <button
                  type="button"
                  className={`${actionClass} mt-5 text-left`}
                  onClick={() => setSshOpen(true)}
                >
                  <FolderSimple className="size-5 shrink-0" weight="regular" />
                  SSH Open folder
                </button>
                {openedFolder ? (
                  <p className="truncate font-mono text-[10px] text-stone-400" title={openedFolder.path}>
                    {openedFolder.host}:{openedFolder.path}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-auto">
              <ProfileChip variant="sidebar" />
            </div>
          </div>
        }
      >
        {children}
      </WorkspaceShell>

      <SshOpenFolderDialog
        open={sshOpen}
        onClose={() => setSshOpen(false)}
        onOpened={info => setOpenedFolder(info)}
      />
    </>
  );
}
