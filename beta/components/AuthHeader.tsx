"use client";

import { AquinBrand } from "@/components/ui/AquinBrand";
import { PoliciesDropdown } from "@/components/PoliciesDropdown";
import { CliTokenDropdown } from "@/components/account/CliTokenSection";
import ProfileChip from "@/components/account/ProfileChip";

type AuthHeaderProps = {
  showProfile?: boolean;
  showCliToken?: boolean;
};

export function AuthHeader({ showProfile = false, showCliToken = false }: AuthHeaderProps) {
  return (
    <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-4 px-6 py-4 bg-background/95 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-4">
        <AquinBrand size="sm" href="/" />
        <PoliciesDropdown />
      </div>
      {showProfile || showCliToken ? (
        <div className="flex shrink-0 items-center gap-3">
          {showCliToken ? <CliTokenDropdown /> : null}
          {showProfile ? <ProfileChip /> : null}
        </div>
      ) : null}
    </header>
  );
}
