"use client";

import { useState } from "react";
import { Cloud, Database, HardDrives } from "@phosphor-icons/react";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { SshOpenFolderDialog } from "@/components/workspace/SshOpenFolderDialog";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { morphMenuContentClass, morphMenuTriggerClass } from "@/lib/morphMenu";

type WorkspaceHomeProps = {
  children: React.ReactNode;
};

/** Owner home chrome: aq-token + connect compute top, profile bottom in sidebar. */
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
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1">
              <div className="flex flex-col items-stretch gap-3">
                <div className="flex flex-col items-stretch gap-0">
                  <CliTokenDropdown />

                  <DropdownMenu>
                    <DropdownMenuTrigger className={morphMenuTriggerClass()}>
                      <Database className="size-[18px] shrink-0" weight="regular" />
                      Connect compute
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      side="bottom"
                      sideOffset={0}
                      onCloseAutoFocus={e => e.preventDefault()}
                      className={morphMenuContentClass()}
                    >
                      <DropdownMenuItem onSelect={() => setSshOpen(true)}>
                        <HardDrives weight="regular" />
                        SSH machine
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled>
                        <Cloud weight="regular" />
                        Azure
                        <span className="ml-auto rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-stone-500 dark:bg-white/10 dark:text-stone-400">
                          Soon
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        <Cloud weight="regular" />
                        AWS
                        <span className="ml-auto rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-stone-500 dark:bg-white/10 dark:text-stone-400">
                          Soon
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        <Cloud weight="regular" />
                        Modal
                        <span className="ml-auto rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-stone-500 dark:bg-white/10 dark:text-stone-400">
                          Soon
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {openedFolder ? (
                    <p
                      className="truncate px-3 font-mono text-[10px] text-stone-400"
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
