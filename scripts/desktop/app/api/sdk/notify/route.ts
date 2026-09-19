import { NextRequest, NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";

// POST /api/sdk/notify
// Called by the VM when a pushed package is received and ready for inspection.
// Writes a notification row which the frontend picks up via Supabase Realtime.
// Body: { user_id, run_id, run_name, base_model }
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.VM_SERVICE_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { user_id, run_id, run_name, base_model } = body;
  if (!user_id || !run_id) {
    return NextResponse.json({ error: "user_id and run_id required" }, { status: 400 });
  }

  const { error } = await supabaseService.from("sdk_notifications").insert({
    user_id,
    run_id,
    run_name: run_name ?? "sdk-run",
    base_model: base_model ?? "",
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
