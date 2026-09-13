/** Shared Aquin auth portal styling (matches aquin.app marketing site). */

export const inputCls =
  "w-full px-4 py-3 rounded-xl border-2 border-black/10 bg-transparent text-[15px] text-stone-900 placeholder-stone-400 focus:outline-none focus:ring-0 focus:border-2 focus:border-black/20 transition-colors dark:border-white/15 dark:text-stone-100 dark:placeholder-stone-500 dark:focus:border-white/30";

/** Email row: bordered shell with borderless field + inset Continue CTA. */
export const inputShellCls =
  "flex items-center gap-2 rounded-xl border-2 border-black/10 bg-transparent p-1.5 pl-4 transition-colors focus-within:border-black/20 dark:border-white/15 dark:focus-within:border-white/30";

export const inputInnerCls =
  "min-w-0 flex-1 bg-transparent text-[15px] text-stone-900 placeholder-stone-400 focus:outline-none dark:text-stone-100 dark:placeholder-stone-500";

export const continueInInputBtnCls =
  "inline-flex h-10 shrink-0 items-center rounded-xl bg-black px-4 text-[15px] font-semibold tracking-tight text-white transition-colors hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white";

export const labelCls =
  "block text-xs font-host-grotesk uppercase tracking-widest text-stone-500 mb-2 dark:text-stone-400";

export const headingLg =
  "font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900 leading-tight dark:text-stone-100";

export const headingMd =
  "font-host-grotesk text-2xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-stone-100";

export const panelCls =
  "rounded-xl border border-stone-200 bg-white/80 px-4 py-3 dark:border-stone-700 dark:bg-stone-900/80";

export const messageErrorCls =
  "text-xs font-host-grotesk text-stone-500 border border-stone-200 rounded-xl px-4 py-3 bg-white/80 dark:text-stone-300 dark:border-stone-700 dark:bg-stone-900/80";

export const messageSuccessCls =
  "text-xs font-host-grotesk text-stone-600 border border-stone-200 rounded-xl px-4 py-3 bg-[#ffee91]/40 dark:text-stone-200 dark:border-amber-500/30 dark:bg-amber-500/15";

export const primaryBtnCls =
  "w-full inline-flex justify-center items-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-black text-white hover:bg-black/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white";

export const secondaryBtnCls =
  "w-full inline-flex justify-center items-center gap-1.5 rounded-xl border border-stone-300 px-3 py-2.5 text-xs font-medium text-stone-800 hover:bg-[#d6d3d1]/40 transition-colors dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800";

export const ghostBtnCls =
  "w-full py-2.5 px-4 rounded-xl text-xs font-medium border border-stone-200 text-stone-600 hover:bg-white/60 transition-colors dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800/60";
