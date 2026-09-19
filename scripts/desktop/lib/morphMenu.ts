import { cn } from "@/lib/utils";

/**
 * Sidebar row trigger — Cursor-like when closed; morphs into attached panel when open.
 */
export function morphMenuTriggerClass(opts?: { openEdge?: "bottom" | "top" }) {
  const openEdge = opts?.openEdge ?? "bottom";

  return cn(
    "aquin-no-drag flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium outline-none transition-all duration-200",
    "text-stone-600 opacity-90 hover:bg-black/[0.04] hover:text-stone-900 hover:opacity-100",
    "dark:text-stone-300 dark:opacity-80 dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f3] dark:hover:opacity-100",
    "data-[state=open]:z-50 data-[state=open]:border-2 data-[state=open]:border-black/10 data-[state=open]:opacity-100",
    "data-[state=open]:bg-white data-[state=open]:px-3 data-[state=open]:py-2.5 data-[state=open]:text-sm data-[state=open]:text-stone-900",
    "data-[state=open]:shadow-[0_8px_30px_rgba(0,0,0,0.08)]",
    "dark:data-[state=open]:border-white/10 dark:data-[state=open]:bg-[#0a0a0a]",
    "dark:data-[state=open]:text-[#f5f5f3] dark:data-[state=open]:opacity-100 dark:data-[state=open]:shadow-[0_8px_30px_rgba(0,0,0,0.45)]",
    openEdge === "bottom"
      ? "data-[state=open]:rounded-2xl data-[state=open]:rounded-b-none data-[state=open]:border-b-transparent dark:data-[state=open]:border-b-transparent"
      : "data-[state=open]:rounded-2xl data-[state=open]:rounded-t-none data-[state=open]:border-t-transparent dark:data-[state=open]:border-t-transparent",
  );
}

export function morphMenuContentClass(opts?: { openEdge?: "bottom" | "top" }) {
  const openEdge = opts?.openEdge ?? "bottom";
  return cn(
    "w-[var(--radix-dropdown-menu-trigger-width)] min-w-[var(--radix-dropdown-menu-trigger-width)]",
    openEdge === "bottom"
      ? "rounded-t-none rounded-b-2xl border-2 border-t-0"
      : "rounded-b-none rounded-t-2xl border-2 border-b-0",
    "border-black/10 p-2",
    "shadow-[0_8px_30px_rgba(0,0,0,0.08)]",
    "dark:border-white/10 dark:shadow-[0_8px_30px_rgba(0,0,0,0.45)]",
  );
}

export function morphPopoverContentClass(opts?: { openEdge?: "bottom" | "top" }) {
  return cn(morphMenuContentClass(opts), "p-0");
}
