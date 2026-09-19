import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptCliToken } from "@/lib/cliTokenCrypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getActiveKeyForReveal } from "@/lib/apiKeysDb";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Password is required." }, { status: 400 });
  }

  if (!password) {
    return NextResponse.json({ error: "Password is required." }, { status: 400 });
  }

  const verify = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: authError } = await verify.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (authError) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const reveal = await getActiveKeyForReveal(user.id);
  if (reveal.error) {
    return NextResponse.json({ error: reveal.error }, { status: 500 });
  }
  if (!reveal.cipherSupported) {
    return NextResponse.json(
      {
        error: "Copy-back is not enabled on this server yet. Regenerate after the database migration, or use the token shown at generation time.",
        code: "cipher_unsupported",
      },
      { status: 503 },
    );
  }

  const keyRow = reveal.row;
  if (!keyRow) {
    return NextResponse.json({ error: "No active CLI token." }, { status: 404 });
  }
  if (!keyRow.key_ciphertext) {
    return NextResponse.json(
      {
        error:
          "This token was created before copy-back was enabled. Regenerate once to store a retrievable copy.",
        code: "not_revealable",
      },
      { status: 400 },
    );
  }

  try {
    const key = decryptCliToken(keyRow.key_ciphertext, user.id);
    return NextResponse.json({ key, key_prefix: keyRow.key_prefix });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not decrypt token.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
