/**
 * Backfill profiles.username from first name (email local as fallback).
 *
 * Dry run (default):
 *   npx tsx scripts/backfill-usernames.ts
 *
 * Apply:
 *   npx tsx scripts/backfill-usernames.ts --apply
 */
import { createClient } from "@supabase/supabase-js";
import {
  nextAvailableUsername,
  usernameBaseFromProfile,
} from "../lib/username";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }

  const sb = createClient(url, key);
  const { data: rows, error } = await sb
    .from("profiles")
    .select("id, name, email, username")
    .order("created_at", { ascending: true });

  if (error) throw error;
  const profiles = rows ?? [];

  const taken = new Set<string>();
  for (const p of profiles) {
    if (p.username) taken.add(String(p.username).toLowerCase());
  }

  const plan: { id: string; name: string | null; email: string | null; from: string | null; to: string }[] =
    [];

  for (const p of profiles) {
    if (p.username) continue;
    const base = usernameBaseFromProfile(p.name, p.email);
    const to = nextAvailableUsername(base, taken);
    taken.add(to);
    plan.push({
      id: p.id,
      name: p.name,
      email: p.email,
      from: p.username,
      to,
    });
  }

  console.log(
    `${apply ? "APPLY" : "DRY RUN"}: ${plan.length} usernames to assign (${profiles.length - plan.length} already set)`,
  );
  for (const row of plan.slice(0, 40)) {
    console.log(`  ${row.name ?? "(no name)"} <${row.email ?? "?"}> → @${row.to}`);
  }
  if (plan.length > 40) console.log(`  … +${plan.length - 40} more`);

  if (!apply) {
    console.log("\nRe-run with --apply to write.");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const row of plan) {
    const { error: upErr } = await sb.from("profiles").update({ username: row.to }).eq("id", row.id);
    if (upErr) {
      fail += 1;
      console.error(`fail ${row.id} → ${row.to}:`, upErr.message);
    } else {
      ok += 1;
    }
  }
  console.log(`\nDone. updated=${ok} failed=${fail}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
