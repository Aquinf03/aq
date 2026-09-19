import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type AquinButtonProps = {
  href?: string;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  fullWidth?: boolean;
};

export function AquinButton({
  href,
  className,
  onClick,
  type = "button",
  disabled,
  children,
  variant = "primary",
  fullWidth = true,
}: AquinButtonProps) {
  const base = cn(
    "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
    fullWidth && "w-full",
    variant === "primary" && "bg-black text-white hover:bg-black/90 py-3 px-4",
    variant === "secondary" &&
      "border border-stone-300 text-stone-800 hover:bg-[#d6d3d1]/40 py-2.5 px-4 text-xs font-medium",
    variant === "ghost" &&
      "border border-stone-200 text-stone-600 hover:bg-white/60 py-2.5 px-4 text-xs font-medium",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={base} onClick={onClick}>
        {children}
      </Link>
    );
  }

  return (
    <button type={type} className={base} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
