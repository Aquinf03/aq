/* eslint-disable @next/next/no-img-element */
import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/config";

type AquinBrandProps = {
  size?: "sm" | "md" | "lg";
  className?: string;
  href?: string;
  /** Logo mark only — no “Aquin Labs” wordmark (desktop chrome). */
  markOnly?: boolean;
};

const sizes = {
  sm: { logo: "h-[22px]", text: "text-lg" },
  md: { logo: "h-7", text: "text-xl sm:text-2xl" },
  lg: { logo: "h-7", text: "text-xl" },
};

/** Black mark on light paper; white mark on black (Aquin public siblings). */
export function AquinBrand({
  size = "sm",
  className,
  href = siteConfig.links.mainSite,
  markOnly = false,
}: AquinBrandProps) {
  const s = sizes[size];
  return (
    <a
      href={href}
      className={cn("inline-flex items-center shrink-0 min-w-0", className)}
      title="Aquin"
    >
      <span className={cn("relative inline-flex shrink-0", s.logo, !markOnly && "mr-1.5")}>
        <img
          src="/mainlogo2.png"
          alt=""
          aria-hidden
          className={cn("h-full w-auto dark:hidden")}
        />
        <img
          src="/mainlogo.png"
          alt=""
          aria-hidden
          className={cn("hidden h-full w-auto dark:block")}
        />
      </span>
      <span className="sr-only">Aquin</span>
      {!markOnly ? (
        <span className={cn("font-semibold tracking-tighter text-stone-900 font-sans dark:text-[#f5f5f3]", s.text)}>
          Aquin
          <span className="ml-[0.25ch]">Labs</span>
        </span>
      ) : null}
    </a>
  );
}
