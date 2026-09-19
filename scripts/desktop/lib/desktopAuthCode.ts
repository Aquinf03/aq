import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

const CODE_TTL_MS = 5 * 60 * 1000;

export type DesktopAuthPayload = {
  api_key: string;
  user_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  exp: number;
  jti: string;
};

function deriveDesktopKey(): Buffer {
  const secret =
    process.env.AQUIN_DESKTOP_AUTH_SECRET ??
    process.env.AQUIN_CLI_TOKEN_ENCRYPTION_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("Desktop auth encryption is not configured on the server.");
  }
  return createHash("sha256")
    .update(secret)
    .update("aquin-desktop-auth-v1")
    .digest();
}

/** Seal a short-lived desktop handoff payload (not a browser session). */
export function sealDesktopAuthCode(payload: Omit<DesktopAuthPayload, "exp" | "jti">): string {
  const full: DesktopAuthPayload = {
    ...payload,
    exp: Date.now() + CODE_TTL_MS,
    jti: randomBytes(12).toString("hex"),
  };
  const key = deriveDesktopKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(full), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function openDesktopAuthCode(
  code: string,
): { ok: true; payload: DesktopAuthPayload } | { ok: false; error: string } {
  try {
    const buf = Buffer.from(String(code || "").trim(), "base64url");
    if (buf.length < 29) {
      return { ok: false, error: "Invalid desktop sign-in code." };
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveDesktopKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(json) as DesktopAuthPayload;
    if (!payload?.api_key || !payload?.user_id || !payload?.exp) {
      return { ok: false, error: "Invalid desktop sign-in code." };
    }
    if (Date.now() > Number(payload.exp)) {
      return { ok: false, error: "This sign-in link expired. Try again from aquin.app." };
    }
    if (!String(payload.api_key).startsWith("aq-")) {
      return { ok: false, error: "Invalid desktop sign-in payload." };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: "Invalid or corrupted desktop sign-in code." };
  }
}

export function desktopDeepLink(code: string): string {
  return `aquin://auth?code=${encodeURIComponent(code)}`;
}
