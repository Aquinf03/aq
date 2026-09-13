"use client";

import { cn } from "@/lib/utils";

type WorkspaceShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  mainHeader?: React.ReactNode;
  className?: string;
};

/** Left sidebar + inset rounded main (layout only). */
export function WorkspaceShell({ sidebar, children, mainHeader, className }: WorkspaceShellProps) {
  return (
    <div className={cn("h-svh w-full bg-stone-100 dark:bg-black", className)}>
      <div className="flex h-full min-h-0 overflow-hidden bg-stone-100 dark:bg-black">
        <aside className="flex w-[240px] shrink-0 flex-col bg-stone-100 dark:bg-black">
          {sidebar}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col pb-1 pr-1 pt-[22px] pl-0.5 sm:pb-1.5 sm:pr-1.5 sm:pt-[30px] sm:pl-1">
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.35rem] border-2 border-black/10 bg-stone-50 dark:border-white/10 dark:bg-[#0a0a0a]">
            {mainHeader ? (
              <div className="flex shrink-0 items-center justify-end gap-3 px-4 py-3 sm:px-5">
                {mainHeader}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-2 sm:px-8 sm:pb-10 sm:pt-4">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
