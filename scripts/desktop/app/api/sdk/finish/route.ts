import { NextRequest, NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/apiKeyAuth";
import { supabaseService } from "@/lib/supabase/service";

// POST /api/sdk/finish — mark run complete, store final config
// Body: { run_id, status?: "complete"|"failed", config? }
export async function POST(req: NextRequest) {
  const auth = await resolveApiKey(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const run_id = body.run_id;
  if (typeof run_id !== "string") return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const status = body.status === "failed" ? "failed" : "complete";
  const update: Record<string, unknown> = { status, finished_at: new Date().toISOString() };
  if (body.config && typeof body.config === "object") update.config = body.config;

  const { error } = await supabaseService
    .from("runs")
    .update(update)
    .eq("id", run_id)
    .eq("user_id", auth.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
