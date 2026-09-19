import { supabaseService } from "@/lib/supabase/service";

const BASE_COLS = "id, key_prefix, name, created_at, last_used_at, revoked_at";

export function isMissingCipherColumn(error: { message?: string } | null | undefined): boolean {
  const msg = (error?.message ?? "").toLowerCase();
  return msg.includes("key_ciphertext");
}

export async function listActiveApiKeys(userId: string) {
  const withCipher = await supabaseService
    .from("api_keys")
    .select(`${BASE_COLS}, key_ciphertext`)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!withCipher.error) {
    return {
      keys: (withCipher.data ?? []).map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        name: k.name,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        revoked: k.revoked_at !== null,
        revealable: !!k.key_ciphertext,
      })),
      cipherSupported: true,
    };
  }

  if (!isMissingCipherColumn(withCipher.error)) {
    return { error: withCipher.error.message, keys: [], cipherSupported: false };
  }

  const fallback = await supabaseService
    .from("api_keys")
    .select(BASE_COLS)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fallback.error) {
    return { error: fallback.error.message, keys: [], cipherSupported: false };
  }

  return {
    keys: (fallback.data ?? []).map((k) => ({
      id: k.id,
      key_prefix: k.key_prefix,
      name: k.name,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      revoked: k.revoked_at !== null,
      revealable: false,
    })),
    cipherSupported: false,
  };
}

export async function insertApiKey(row: {
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  key_ciphertext?: string | null;
}) {
  const base = {
    user_id: row.user_id,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    name: row.name,
    scopes: row.scopes,
  };

  if (row.key_ciphertext) {
    const withCipher = await supabaseService
      .from("api_keys")
      .insert({ ...base, key_ciphertext: row.key_ciphertext })
      .select("id, key_prefix, name, created_at")
      .single();

    if (!withCipher.error) {
      return { data: withCipher.data, revealable: true, cipherSupported: true };
    }
    if (!isMissingCipherColumn(withCipher.error)) {
      return { error: withCipher.error.message };
    }
  }

  const plain = await supabaseService
    .from("api_keys")
    .insert(base)
    .select("id, key_prefix, name, created_at")
    .single();

  if (plain.error) {
    return { error: plain.error.message };
  }
  return {
    data: plain.data,
    revealable: false,
    cipherSupported: false,
  };
}

export async function getActiveKeyForReveal(userId: string) {
  const withCipher = await supabaseService
    .from("api_keys")
    .select("id, key_ciphertext, key_prefix")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!withCipher.error) {
    return { row: withCipher.data, cipherSupported: true };
  }
  if (!isMissingCipherColumn(withCipher.error)) {
    return { error: withCipher.error.message, cipherSupported: false };
  }
  return { row: null, cipherSupported: false };
}
