"use client";

import { AquinBrand } from "@/components/ui/AquinBrand";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

type WorkspaceHomeProps = {
  children: React.ReactNode;
};

/** Owner home chrome: brand + aq-token top, profile bottom in sidebar. */
export function WorkspaceHome({ children }: WorkspaceHomeProps) {
  return (
    <WorkspaceShell
      sidebar={
        <div className="flex h-full flex-col px-4 pb-3 pt-4">
          <div className="flex flex-col items-stretch gap-3">
            <div className="flex items-center pr-9">
              <AquinBrand size="sm" href="/" />
            </div>
            <div className="pt-2">
              <CliTokenDropdown />
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
  );
}
