import { NextRequest, NextResponse } from "next/server";
import { openDesktopAuthCode } from "@/lib/desktopAuthCode";

export async function POST(req: NextRequest) {
  let code = "";
  try {
    const body = await req.json();
    code = String(body?.code ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: "Missing sign-in code." }, { status: 400 });
  }

  const opened = openDesktopAuthCode(code);
  if (!opened.ok) {
    return NextResponse.json({ error: opened.error }, { status: 400 });
  }

  const { payload } = opened;
  return NextResponse.json({
    api_key: payload.api_key,
    user_id: payload.user_id,
    email: payload.email,
    name: payload.name,
    avatar_url: payload.avatar_url ?? null,
  });
}
