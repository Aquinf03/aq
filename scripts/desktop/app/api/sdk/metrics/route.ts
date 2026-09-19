import { NextRequest, NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/apiKeyAuth";
import { supabaseService } from "@/lib/supabase/service";

// POST /api/sdk/metrics — log one or more steps
// Body: { run_id, step, metrics: { loss, learning_rate, ... } }
//    or { run_id, batch: [{ step, metrics }] }
export async function POST(req: NextRequest) {
  const auth = await resolveApiKey(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const run_id = body.run_id;
  if (typeof run_id !== "string") return NextResponse.json({ error: "run_id required" }, { status: 400 });

  // Verify this run belongs to the authed user
  const { data: run } = await supabaseService
    .from("runs")
    .select("id")
    .eq("id", run_id)
    .eq("user_id", auth.userId)
    .single();

  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Support single step or batch
  type StepEntry = { step: number; metrics: Record<string, unknown> };
  const entries: StepEntry[] = [];

  if (Array.isArray(body.batch)) {
    for (const item of body.batch as unknown[]) {
      if (item && typeof item === "object") {
        const s = item as Record<string, unknown>;
        if (typeof s.step === "number" && s.metrics && typeof s.metrics === "object") {
          entries.push({ step: s.step, metrics: s.metrics as Record<string, unknown> });
        }
      }
    }
  } else if (typeof body.step === "number" && body.metrics && typeof body.metrics === "object") {
    entries.push({ step: body.step, metrics: body.metrics as Record<string, unknown> });
  }

  if (entries.length === 0) return NextResponse.json({ error: "No valid steps" }, { status: 400 });

  const rows = entries.map(e => ({ run_id, step: e.step, metrics: e.metrics }));
  const { error } = await supabaseService.from("run_metrics").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, logged: rows.length });
}

// GET /api/sdk/metrics?run_id=... — fetch metrics for dashboard polling
export async function GET(req: NextRequest) {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const run_id = req.nextUrl.searchParams.get("run_id");
  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  // Verify ownership
  const { data: run } = await supabaseService
    .from("runs")
    .select("id")
    .eq("id", run_id)
    .eq("user_id", user.id)
    .single();

  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseService
    .from("run_metrics")
    .select("step, metrics, logged_at")
    .eq("run_id", run_id)
    .order("step", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
