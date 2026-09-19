import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { siteConfig } from "./config";

/** Loose metadata shape (Next Metadata-compatible without importing `next`). */
type MetadataLike = Record<string, unknown>;

/** Shared OG image for every web page (Aquin home brand art). */
export const OG_IMAGE = "/og/home.jpg";
export const OG_IMAGE_WIDTH = 1024;
export const OG_IMAGE_HEIGHT = 576;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function publicEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  try {
    // Vite
    const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
    return env?.[name];
  } catch {
    return undefined;
  }
}

export function absoluteUrl(path: string) {
  return `${publicEnv("NEXT_PUBLIC_APP_URL") || siteConfig.url}${path}`;
}

export function constructMetadata({
  title = siteConfig.name,
  description = siteConfig.description,
  image = OG_IMAGE,
  ...props
}: {
  title?: string;
  description?: string;
  image?: string;
  [key: string]: unknown;
}): MetadataLike {
  return {
    title: {
      template: "%s | " + siteConfig.name,
      default: title,
    },
    description: description || siteConfig.description,
    keywords: siteConfig.keywords,
    openGraph: {
      title,
      description,
      url: siteConfig.url,
      siteName: siteConfig.name,
      images: [
        {
          url: image,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: title,
        },
      ],
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    icons: {
      icon: [{ url: "/favicon.ico" }, { url: "/icon.png", type: "image/png" }],
      apple: "/icon.png",
    },
    metadataBase: new URL(siteConfig.url),
    authors: [{ name: siteConfig.name, url: siteConfig.links.mainSite }],
    creator: siteConfig.name,
    publisher: siteConfig.name,
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
      },
    },
    ...props,
  };
}
