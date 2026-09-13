"use client";

import { AquinBrand } from "@/components/ui/AquinBrand";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

type WorkspaceHomeProps = {
  children: React.ReactNode;
};

/** Owner home chrome: brand + profile in sidebar; CLI token in main header. */
export function WorkspaceHome({ children }: WorkspaceHomeProps) {
  return (
    <WorkspaceShell
      mainHeader={<CliTokenDropdown />}
      sidebar={
        <div className="flex h-full flex-col px-4 pb-3 pt-4">
          <div className="flex items-center">
            <AquinBrand size="sm" href="/" />
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
