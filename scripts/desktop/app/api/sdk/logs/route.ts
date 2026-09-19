import { NextRequest, NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/apiKeyAuth";
import { supabaseService } from "@/lib/supabase/service";

// POST /api/sdk/logs — ingest a batch of log lines from the SDK
// Body: { run_id, lines: string[] }
export async function POST(req: NextRequest) {
  const auth = await resolveApiKey(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const run_id = body.run_id;
  if (typeof run_id !== "string") return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const lines = Array.isArray(body.lines)
    ? (body.lines as unknown[]).filter(l => typeof l === "string" && (l as string).trim()) as string[]
    : [];

  if (lines.length === 0) return NextResponse.json({ ok: true, logged: 0 });

  const { data: run } = await supabaseService
    .from("runs")
    .select("id")
    .eq("id", run_id)
    .eq("user_id", auth.userId)
    .single();

  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const rows = lines.map(line => ({ run_id, line }));
  const { error } = await supabaseService.from("run_logs").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, logged: rows.length });
}

// GET /api/sdk/logs?run_id=... — fetch existing log lines (initial load)
export async function GET(req: NextRequest) {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const run_id = req.nextUrl.searchParams.get("run_id");
  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const { data: run } = await supabaseService
    .from("runs")
    .select("id")
    .eq("id", run_id)
    .eq("user_id", user.id)
    .single();

  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabaseService
    .from("run_logs")
    .select("id, line, logged_at")
    .eq("run_id", run_id)
    .order("logged_at", { ascending: true })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
