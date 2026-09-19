import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { decryptCliToken, encryptCliToken } from "@/lib/cliTokenCrypto";
import { getActiveKeyForReveal, insertApiKey } from "@/lib/apiKeysDb";
import { desktopDeepLink, sealDesktopAuthCode } from "@/lib/desktopAuthCode";

async function resolveOrCreateApiKey(userId: string): Promise<
  { ok: true; key: string } | { ok: false; error: string }
> {
  const reveal = await getActiveKeyForReveal(userId);
  if (reveal.error) {
    return { ok: false, error: reveal.error };
  }

  if (reveal.row?.key_ciphertext) {
    try {
      const key = decryptCliToken(reveal.row.key_ciphertext, userId);
      if (key.startsWith("aq-")) return { ok: true, key };
    } catch {
      // fall through to mint a fresh key
    }
  }

  await supabaseService
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);

  const raw = "aq-" + randomBytes(16).toString("hex");
  const key_hash = createHash("sha256").update(raw).digest("hex");
  const key_prefix = raw.slice(0, 12);

  let key_ciphertext: string | null = null;
  try {
    key_ciphertext = encryptCliToken(raw, userId);
  } catch (e) {
    console.error("[auth/desktop/mint] encrypt failed:", e);
  }

  const inserted = await insertApiKey({
    user_id: userId,
    key_hash,
    key_prefix,
    key_ciphertext,
    name: "Desktop + CLI token",
    scopes: ["general"],
  });

  if (inserted.error || !inserted.data) {
    return { ok: false, error: inserted.error ?? "Could not create token." };
  }
  return { ok: true, key: raw };
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await resolveOrCreateApiKey(user.id);
  if (!token.ok) {
    return NextResponse.json({ error: token.error }, { status: 500 });
  }

  let email: string | null = user.email ?? null;
  let name: string | null =
    (typeof user.user_metadata?.name === "string"
      ? user.user_metadata.name
      : null) || null;
  let avatar_url: string | null =
    (typeof user.user_metadata?.avatar_url === "string"
      ? user.user_metadata.avatar_url
      : typeof user.user_metadata?.picture === "string"
        ? user.user_metadata.picture
        : null) || null;

  try {
    const { data: profile } = await supabaseService
      .from("profiles")
      .select("email, name, avatar_url")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.email) email = String(profile.email);
    if (profile?.name) name = String(profile.name);
    if (profile?.avatar_url) avatar_url = String(profile.avatar_url);
  } catch {
    // identity from auth user is enough
  }

  try {
    const code = sealDesktopAuthCode({
      api_key: token.key,
      user_id: user.id,
      email,
      name,
      avatar_url,
    });
    return NextResponse.json({
      code,
      deep_link: desktopDeepLink(code),
      email,
      name,
      avatar_url,
      expires_in_seconds: 300,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not mint handoff code.";
    console.error("[auth/desktop/mint]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
