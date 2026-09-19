import { NextRequest, NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/apiKeyAuth";
import { supabaseService } from "@/lib/supabase/service";

export async function POST(req: NextRequest) {
  const auth = await resolveApiKey(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { run_id } = body as { run_id?: string };
  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  await supabaseService
    .from("runs")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", run_id)
    .eq("user_id", auth.userId);

  return NextResponse.json({ ok: true });
}
