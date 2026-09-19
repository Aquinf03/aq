import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";

export type ApiKeyAuthResult =
  | { status: "ok"; userId: string }
  | { status: "revoked"; userId: string; revokedAt: string }
  | { status: "invalid" };

export async function resolveApiKeyDetailed(
  authHeader: string | null,
  requiredScope?: string,
): Promise<ApiKeyAuthResult> {
  if (!authHeader?.startsWith("Bearer aq-")) return { status: "invalid" };
  const raw = authHeader.slice("Bearer ".length).trim();
  if (!raw) return { status: "invalid" };
  const hash = createHash("sha256").update(raw).digest("hex");

  let query = supabaseService
    .from("api_keys")
    .select("user_id, revoked_at, scopes")
    .eq("key_hash", hash);

  if (requiredScope) {
    query = query.contains("scopes", [requiredScope]);
  }

  const { data } = await query.single();

  if (!data) return { status: "invalid" };
  if (data.revoked_at) {
    return {
      status: "revoked",
      userId: data.user_id,
      revokedAt: data.revoked_at,
    };
  }

  supabaseService
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", hash)
    .then(() => {});

  return { status: "ok", userId: data.user_id };
}

export async function resolveApiKey(
  authHeader: string | null,
  requiredScope?: string,
): Promise<{ userId: string } | null> {
  const result = await resolveApiKeyDetailed(authHeader, requiredScope);
  if (result.status !== "ok") return null;
  return { userId: result.userId };
}

export function unauthorizedKeyResponse(result: ApiKeyAuthResult) {
  if (result.status === "revoked") {
    return NextResponse.json(
      {
        error: "Token revoked",
        revoked_at: result.revokedAt,
        hint: "Regenerate your CLI token at aquin.app (Profile -> Account -> CLI token), then run aquin login.",
      },
      { status: 401 },
    );
  }
  return NextResponse.json(
    {
      error: "Unauthorized",
      hint: "Run aquin login with the CLI token from aquin.app (Profile -> Account -> CLI token).",
    },
    { status: 401 },
  );
}
