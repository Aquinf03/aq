import type { Metadata, Viewport } from "next";
import { Roboto, Cardo, Host_Grotesk } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ThemeScript } from "@/components/ThemeScript";
import { cn, constructMetadata } from "@/lib/utils";
import { siteConfig } from "@/lib/config";

const roboto = Roboto({
  weight: ["300", "400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-roboto",
});

const cardo = Cardo({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-cardo",
});

/** Ready via `font-host-grotesk` / `var(--font-host-grotesk)`. */
const hostGrotesk = Host_Grotesk({
  subsets: ["latin"],
  variable: "--font-host-grotesk",
});

export const metadata: Metadata = constructMetadata({
  title: `${siteConfig.name} | Docs`,
  description: siteConfig.description,
});

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f3" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body
        className={cn(
          `${roboto.variable} ${cardo.variable} ${hostGrotesk.variable} min-h-screen bg-background text-foreground overflow-x-hidden antialiased w-full mx-auto scroll-smooth font-host-grotesk`,
        )}
      >
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
