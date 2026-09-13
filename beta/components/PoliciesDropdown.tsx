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
      <DropdownMenuTrigger className="inline-flex items-center gap-1 text-sm font-medium font-host-grotesk text-stone-600 outline-none hover:text-stone-900 transition-colors data-[state=open]:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100 dark:data-[state=open]:text-stone-100">
        Policies
        <CaretDown className="size-3.5" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="min-w-[15rem] rounded-xl border-stone-200 bg-white p-1.5 shadow-lg dark:border-stone-700 dark:bg-stone-900"
      >
        {POLICY_LINKS.map((link) => (
          <DropdownMenuItem
            key={link.href}
            asChild
            className="rounded-lg font-host-grotesk text-stone-700 focus:bg-stone-50 focus:text-stone-900 dark:text-stone-200 dark:focus:bg-stone-800 dark:focus:text-stone-100"
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
