import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function deriveKey(userId: string): Buffer {
  const secret =
    process.env.AQUIN_CLI_TOKEN_ENCRYPTION_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("CLI token encryption is not configured on the server.");
  }
  return createHash("sha256").update(secret).update(userId).digest();
}

/** Encrypt a raw CLI token for storage (AES-256-GCM, per-user key). */
export function encryptCliToken(plaintext: string, userId: string): string {
  const key = deriveKey(userId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a stored CLI token ciphertext. */
export function decryptCliToken(payload: string, userId: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 29) {
    throw new Error("Invalid encrypted token payload.");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(userId), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
