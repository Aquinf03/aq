import { createBrowserClient } from "@supabase/ssr";

function env(name: string, fallback: string): string {
  if (typeof process !== "undefined" && process.env?.[name]) {
    return process.env[name] as string;
  }
  try {
    const v = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.[name];
    if (v) return v;
  } catch {
    /* not Vite */
  }
  return fallback;
}

export function createClient() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.supabase.co");
  const key = env("NEXT_PUBLIC_SUPABASE_ANON_KEY", "placeholder-anon-key");
  return createBrowserClient(url, key);
}
