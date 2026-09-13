import type { Metadata } from "next";
import AuthPortal from "@/components/AuthPortal";
import { siteConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: {
    absolute: `${siteConfig.name} — account & install`,
  },
  description: siteConfig.description,
  keywords: [...siteConfig.keywords],
  alternates: { canonical: siteConfig.url },
};

export default function HomePage() {
  return (
    <div className="min-h-screen w-full bg-background font-sans text-foreground">
      <AuthPortal />
    </div>
  );
}
