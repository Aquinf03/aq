/* eslint-disable @next/next/no-img-element */
import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/config";

type AquinBrandProps = {
  size?: "sm" | "md" | "lg";
  className?: string;
  href?: string;
};

const sizes = {
  sm: { logo: "h-[22px]", text: "text-lg" },
  md: { logo: "h-7", text: "text-xl sm:text-2xl" },
  lg: { logo: "h-7", text: "text-xl" },
};

export function AquinBrand({ size = "sm", className, href = siteConfig.links.mainSite }: AquinBrandProps) {
  const s = sizes[size];
  return (
    <a href={href} className={cn("inline-flex items-center shrink-0 min-w-0", className)} title="Aquin Labs">
      <img src="/mainlogo2.png" alt="Aquin" className={cn(s.logo, "mr-1.5")} />
      <span className={cn("font-semibold tracking-tighter text-stone-900 font-sans dark:text-stone-100", s.text)}>
        Aquin
        <span className="ml-[0.25ch]">Labs</span>
      </span>
    </a>
  );
}
