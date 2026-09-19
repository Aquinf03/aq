import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { validateUsername } from "@/lib/username";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const raw = typeof body.username === "string" ? body.username : "";

  let next: string | null = null;
  if (raw.trim()) {
    const checked = validateUsername(raw);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 });
    }
    next = checked.username;
  }

  const service = getSupabaseService();

  if (next) {
    const { data: taken } = await service
      .from("profiles")
      .select("id")
      .eq("username", next)
      .neq("id", user.id)
      .maybeSingle();
    if (taken) {
      return NextResponse.json({ error: "That username is taken." }, { status: 409 });
    }
  }

  const { error } = await service
    .from("profiles")
    .update({ username: next })
    .eq("id", user.id);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return NextResponse.json({ error: "That username is taken." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ username: next });
}
