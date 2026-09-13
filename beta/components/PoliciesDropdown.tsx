"use client";

import { CaretDown } from "@phosphor-icons/react";
import { siteConfig } from "@/lib/config";
import { POLICY_LINKS } from "@/lib/policies";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PoliciesDropdown() {
  const mainSite = siteConfig.links.mainSite.replace(/\/$/, "");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 text-sm font-medium font-host-grotesk text-stone-600 outline-none hover:text-stone-900 transition-colors data-[state=open]:text-stone-900 dark:text-stone-300 dark:hover:text-[#f5f5f3] dark:data-[state=open]:text-[#f5f5f3]">
        Policies
        <CaretDown className="size-3.5" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="min-w-[15rem] rounded-xl border-black/10 bg-white p-1.5 shadow-lg dark:border-white/10 dark:bg-black"
      >
        {POLICY_LINKS.map((link) => (
          <DropdownMenuItem
            key={link.href}
            asChild
            className="rounded-lg font-host-grotesk text-stone-700 focus:bg-black/5 focus:text-stone-900 dark:text-stone-200 dark:focus:bg-white/10 dark:focus:text-[#f5f5f3]"
          >
            <a href={`${mainSite}${link.href}`} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
