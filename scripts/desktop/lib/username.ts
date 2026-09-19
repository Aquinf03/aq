/** Username rules for aq.aquin.app/<username> (logged-in home + public profile). */

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,29}$/;

/** Path segments and product words that must not be claimed. */
export const RESERVED_USERNAMES = new Set([
  "user",
  "users",
  "auth",
  "api",
  "admin",
  "framework",
  "releases",
  "login",
  "signup",
  "signout",
  "logout",
  "account",
  "settings",
  "profile",
  "cli",
  "desktop",
  "install",
  "docs",
  "help",
  "support",
  "status",
  "health",
  "www",
  "app",
  "static",
  "assets",
  "public",
  "null",
  "undefined",
  "me",
  "new",
  "edit",
  "changelog",
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): { ok: true; username: string } | { ok: false; error: string } {
  const username = normalizeUsername(raw);
  if (!username) {
    return { ok: false, error: "Username is required." };
  }
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "Use 3–30 chars: start with a letter, then letters, numbers, _ or -.",
    };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { ok: false, error: "That username is reserved." };
  }
  return { ok: true, username };
}

/** Home / public profile path: /{username} */
export function userProfilePath(username: string): string {
  return `/${normalizeUsername(username)}`;
}

/** Host + path for display (localhost:3000/x or aq.aquin.app/x). */
export function userProfileHref(username: string, origin?: string | null): string {
  const path = userProfilePath(username);
  if (!origin) return path;
  try {
    const u = new URL(origin);
    return `${u.host}${path}`;
  } catch {
    return path;
  }
}

/** First name token, or the part before `.` when the "name" looks like an email local. */
export function firstNameToken(name: string | null | undefined, email?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) {
    const word = trimmed.split(/\s+/)[0] ?? trimmed;
    if (word.includes(".") && !word.includes(" ")) {
      return word.split(".")[0] || word;
    }
    return word;
  }
  const local = (email ?? "").split("@")[0] ?? "";
  if (local.includes(".")) return local.split(".")[0] || local;
  return local;
}

/** Turn a display name / email into a username-shaped slug (may still need uniqueness). */
export function slugifyUsernameCandidate(raw: string): string {
  let s = normalizeUsername(raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/^[_-]+/, "")
    .slice(0, 30);

  if (!s) s = "user";
  if (!/^[a-z]/.test(s)) s = `u${s}`.slice(0, 30);
  if (s.length < 3) s = (s + "xxx").slice(0, 3);
  return s;
}

/**
 * Prefer first name → slug. Falls back to email local part.
 * Returns a base candidate; callers add -2, -3… on collisions.
 */
export function usernameBaseFromProfile(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const fromName = slugifyUsernameCandidate(firstNameToken(name, email));
  if (fromName && !RESERVED_USERNAMES.has(fromName) && USERNAME_RE.test(fromName)) {
    return fromName;
  }
  const fromEmail = slugifyUsernameCandidate((email ?? "").split("@")[0] || "user");
  if (RESERVED_USERNAMES.has(fromEmail)) {
    return slugifyUsernameCandidate(`${fromEmail}1`);
  }
  return fromEmail;
}

/** Next free username: base, then base2, base3… (keeps ≤30 chars). */
export function nextAvailableUsername(base: string, taken: Set<string>): string {
  const root = slugifyUsernameCandidate(base);
  const tryOne = (candidate: string) => {
    const checked = validateUsername(candidate);
    return checked.ok && !taken.has(checked.username) ? checked.username : null;
  };

  const first = tryOne(root);
  if (first) return first;

  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n);
    const trimmed = root.slice(0, Math.max(1, 30 - suffix.length));
    const hit = tryOne(`${trimmed}${suffix}`);
    if (hit) return hit;
  }
  throw new Error(`Could not allocate username from base: ${base}`);
}
