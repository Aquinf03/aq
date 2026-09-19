import { NextRequest, NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";

// GET /api/sdk/analyses?run_id=... — fetch VM analysis results for a run
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
    .from("run_analyses")
    .select("id, step, analysis_type, result, created_at")
    .eq("run_id", run_id)
    .order("step", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
