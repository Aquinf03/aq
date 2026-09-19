import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { nextAvailableUsername, usernameBaseFromProfile } from "@/lib/username";

/** Assign a username from first name (or email) if the profile has none yet. */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const service = getSupabaseService();
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("id, name, email, username")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  }
  if (profile.username) {
    return NextResponse.json({ username: profile.username, created: false });
  }

  const { data: existing, error: listError } = await service
    .from("profiles")
    .select("username")
    .not("username", "is", null);

  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const taken = new Set(
    (existing ?? [])
      .map(r => (typeof r.username === "string" ? r.username.toLowerCase() : ""))
      .filter(Boolean),
  );

  const base = usernameBaseFromProfile(profile.name, profile.email ?? user.email);
  const username = nextAvailableUsername(base, taken);

  const { error: upError } = await service
    .from("profiles")
    .update({ username })
    .eq("id", user.id);

  if (upError) {
    return NextResponse.json({ error: upError.message }, { status: 500 });
  }

  return NextResponse.json({ username, created: true });
}
