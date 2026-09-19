import { NextRequest, NextResponse } from "next/server";
import { resolveApiKeyDetailed, unauthorizedKeyResponse } from "@/lib/apiKeyAuth";

// GET /api/sdk/ping — verify an API key is valid
export async function GET(req: NextRequest) {
  const auth = await resolveApiKeyDetailed(req.headers.get("authorization"));
  if (auth.status !== "ok") return unauthorizedKeyResponse(auth);
  return NextResponse.json({ ok: true, user_id: auth.userId });
}
