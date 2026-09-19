import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { createHash, randomBytes } from "crypto";
import { encryptCliToken } from "@/lib/cliTokenCrypto";
import { insertApiKey } from "@/lib/apiKeysDb";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let name: string | undefined;
  try {
    const body = await req.json();
    name = body?.name;
  } catch {}

  await supabaseService
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("revoked_at", null);

  const raw = "aq-" + randomBytes(16).toString("hex");
  const key_hash = createHash("sha256").update(raw).digest("hex");
  const key_prefix = raw.slice(0, 12);

  let key_ciphertext: string | null = null;
  try {
    key_ciphertext = encryptCliToken(raw, user.id);
  } catch (e) {
    console.error("[api/keys/generate] encrypt failed:", e);
  }

  const inserted = await insertApiKey({
    user_id: user.id,
    key_hash,
    key_prefix,
    key_ciphertext,
    name: name ?? "CLI token",
    scopes: ["general"],
  });

  if (inserted.error || !inserted.data) {
    return NextResponse.json({ error: inserted.error ?? "Could not save token." }, { status: 500 });
  }

  return NextResponse.json({
    key: raw,
    revealable: inserted.revealable,
    cipher_warning: inserted.cipherSupported === false
      ? "Password copy-back needs a database migration (key_ciphertext column). Token still works for aquin login."
      : undefined,
    ...inserted.data,
  });
}
