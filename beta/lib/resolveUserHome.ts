"use client";

import { createClient } from "@/lib/supabase/client";
import { userProfilePath } from "@/lib/username";

/** Ensure the signed-in user has a username and return their home path `/{username}`. */
export async function resolveUserHomePath(userId: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", userId)
    .maybeSingle();

  let username = typeof data?.username === "string" ? data.username.trim() : "";
  if (!username) {
    await fetch("/api/account/username/allocate", { method: "POST" }).catch(() => null);
    const { data: again } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .maybeSingle();
    username = typeof again?.username === "string" ? again.username.trim() : "";
  }
  if (!username) return null;
  return userProfilePath(username);
}
