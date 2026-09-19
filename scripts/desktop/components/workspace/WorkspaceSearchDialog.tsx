"use client";

import {
  FolderOpen,
  GearSix,
  House,
  Key,
  MagnifyingGlass,
  Plus,
  SquaresFour,
} from "@phosphor-icons/react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type WorkspaceSearchAction =
  | "home"
  | "jobs"
  | "new-job"
  | "connect-ssh"
  | "aq-token"
  | "settings";

type RecentItem = {
  id: string;
  label: string;
  kind: "home" | "jobs";
};

type WorkspaceSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recents?: RecentItem[];
  onAction: (action: WorkspaceSearchAction) => void;
  onSelectRecent?: (id: string) => void;
};

const itemClass =
  "gap-2.5 rounded-xl px-3.5 py-2.5 text-[14px] data-[selected=true]:bg-black/[0.07] dark:data-[selected=true]:bg-white/[0.1]";

/** Command palette — Anara-inspired search dialog. */
export function WorkspaceSearchDialog({
  open,
  onOpenChange,
  recents = [],
  onAction,
  onSelectRecent,
}: WorkspaceSearchDialogProps) {
  const run = (action: WorkspaceSearchAction) => {
    onAction(action);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>Search</DialogTitle>
        <DialogDescription>Search workspace and run commands</DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/55"
        className={cn(
          "top-[14%] w-[min(100%-1.5rem,36rem)] max-w-[36rem] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[36rem]",
          "border-2 border-black/15 bg-[#ebeae6] shadow-[0_24px_80px_rgba(0,0,0,0.35)]",
          "dark:border-white/15 dark:bg-[#0c0c0c] dark:shadow-[0_24px_80px_rgba(0,0,0,0.75)]",
        )}
      >
        <Command
          className={cn(
            "rounded-2xl bg-transparent text-stone-900 dark:text-[#f0f0ee]",
            "[&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3.5",
            "[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide",
            "[&_[cmdk-group-heading]]:text-stone-500 dark:[&_[cmdk-group-heading]]:text-stone-500",
            "[&_[cmdk-group]]:px-1.5",
          )}
        >
          <div
            className={cn(
              "border-b-2 border-black/10 dark:border-white/[0.08]",
              "[&_[data-slot=command-input-wrapper]]:h-14 [&_[data-slot=command-input-wrapper]]:border-0",
              "[&_[data-slot=command-input-wrapper]]:px-5 [&_[data-slot=command-input-wrapper]_svg]:hidden",
            )}
          >
            <CommandInput
              placeholder="Search Aquin…"
              className="h-14 text-[16px] text-stone-900 placeholder:text-stone-400 dark:text-[#f0f0ee] dark:placeholder:text-stone-500"
            />
          </div>
          <CommandList className="max-h-[min(62vh,26rem)] px-1.5 pb-3 pt-1">
            <CommandEmpty className="py-10 text-[13px] text-stone-500">No results.</CommandEmpty>

            {recents.length > 0 ? (
              <CommandGroup heading="Recents">
                {recents.map(r => (
                  <CommandItem
                    key={r.id}
                    value={`recent ${r.label}`}
                    onSelect={() => {
                      onSelectRecent?.(r.id);
                      onOpenChange(false);
                    }}
                    className={itemClass}
                  >
                    {r.kind === "home" ? (
                      <House className="size-[18px] shrink-0 opacity-60" weight="regular" />
                    ) : (
                      <SquaresFour className="size-[18px] shrink-0 opacity-60" weight="regular" />
                    )}
                    <span className="truncate">{r.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="Go">
              <CommandItem value="home" onSelect={() => run("home")} className={itemClass}>
                <House className="size-[18px] shrink-0 opacity-60" weight="regular" />
                Home
              </CommandItem>
              <CommandItem value="jobs" onSelect={() => run("jobs")} className={itemClass}>
                <SquaresFour className="size-[18px] shrink-0 opacity-60" weight="regular" />
                Jobs
              </CommandItem>
              <CommandItem value="new job" onSelect={() => run("new-job")} className={itemClass}>
                <Plus className="size-[18px] shrink-0 opacity-60" weight="regular" />
                New job
                <CommandShortcut className="rounded-md bg-black/[0.07] px-1.5 py-0.5 text-[10px] tracking-normal text-stone-500 dark:bg-white/[0.1] dark:text-stone-400">
                  ↵
                </CommandShortcut>
              </CommandItem>
              <CommandItem
                value="connect ssh"
                onSelect={() => run("connect-ssh")}
                className={itemClass}
              >
                <FolderOpen className="size-[18px] shrink-0 opacity-60" weight="regular" />
                Connect SSH…
              </CommandItem>
            </CommandGroup>

            <CommandGroup heading="Account">
              <CommandItem
                value="aq token cli"
                onSelect={() => run("aq-token")}
                className={itemClass}
              >
                <Key className="size-[18px] shrink-0 opacity-60" weight="regular" />
                aq-token
              </CommandItem>
              <CommandItem
                value="settings profile"
                onSelect={() => run("settings")}
                className={itemClass}
              >
                <GearSix className="size-[18px] shrink-0 opacity-60" weight="regular" />
                Settings
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Sidebar search trigger — opens the command dialog. */
export function WorkspaceSearchButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={className}>
      <MagnifyingGlass className="size-[18px] shrink-0" weight="regular" />
      Search
    </button>
  );
}
