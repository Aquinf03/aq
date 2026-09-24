#!/usr/bin/env node
/**
 * Summarize aq download metrics stored in R2 by the releases worker.
 *
 * Loads credentials from (first found):
 *   scripts/helpers/.env.r2
 *   web/.env
 *
 * Or set manually:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   AQUIN_R2_BUCKET (default: releases)
 *
 * Usage:
 *   ./scripts/helpers/download-metrics.sh
 *   ./scripts/helpers/download-metrics.sh --days 30
 *   ./scripts/helpers/download-metrics.sh --since 2026-09-01
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "releases";
const METRICS_PREFIX = "metrics/events/";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadEnv() {
  loadEnvFile(join(SCRIPT_DIR, ".env.r2"));
  loadEnvFile(join(SCRIPT_DIR, "..", "..", "web", ".env"));
  if (!process.env.AQUIN_R2_BUCKET) {
    process.env.AQUIN_R2_BUCKET = DEFAULT_BUCKET;
  }
}

function usage() {
  console.error(`Usage: download-metrics.mjs [--days N] [--since YYYY-MM-DD]

Loads R2 creds from scripts/helpers/.env.r2 or web/.env automatically.

Manual override:
  R2_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  AQUIN_R2_BUCKET       Bucket name (default: ${DEFAULT_BUCKET})
`);
  process.exit(2);
}

function parseArgs(argv) {
  let days = 30;
  let since = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      days = Number(argv[++i]);
      if (!Number.isFinite(days) || days < 1) usage();
    } else if (arg === "--since") {
      since = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) usage();
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  return { days, since };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    console.error("");
    console.error("Expected R2 creds in scripts/helpers/.env.r2 or web/.env");
    process.exit(1);
  }
  return value;
}

function dateRange({ days, since }) {
  const end = new Date();
  const start = since ? new Date(`${since}T00:00:00.000Z`) : new Date(end);
  if (!since) {
    start.setUTCDate(start.getUTCDate() - (days - 1));
  }
  start.setUTCHours(0, 0, 0, 0);

  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listDayKeys(client, bucket, day) {
  const keys = [];
  let token;
  const prefix = `${METRICS_PREFIX}${day}/`;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const item of res.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

async function fetchEvent(client, bucket, key) {
  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const body = await readBody(res.Body);
  return JSON.parse(body);
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function topEntries(map, limit = 10) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function printSection(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = process.env.AQUIN_R2_BUCKET || DEFAULT_BUCKET;

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const dates = dateRange(args);
  const allKeys = [];
  for (const day of dates) {
    const keys = await listDayKeys(client, bucket, day);
    allKeys.push(...keys);
  }

  if (allKeys.length === 0) {
    console.log("No download events found for the selected period.");
    console.log(`Bucket: ${bucket}`);
    console.log(`Days scanned: ${dates[0]} → ${dates.at(-1)}`);
    return;
  }

  const events = [];
  for (const key of allKeys) {
    events.push(await fetchEvent(client, bucket, key));
  }

  const totals = { install: 0, tarball: 0, all: events.length };
  const byAsset = new Map();
  const byDay = new Map();
  const byCountry = new Map();
  const byKindDay = new Map();

  for (const event of events) {
    if (event.kind === "install") totals.install += 1;
    if (event.kind === "tarball") totals.tarball += 1;

    inc(byAsset, event.asset ?? "unknown");
    const day = String(event.ts ?? "").slice(0, 10) || "unknown";
    inc(byDay, day);
    inc(byKindDay, `${day}:${event.kind}`, 1);

    const country = event.country || "unknown";
    inc(byCountry, country);
  }

  const periodLabel = args.since
    ? `${dates[0]} → ${dates.at(-1)} (--since ${args.since})`
    : `last ${args.days} day(s) (${dates[0]} → ${dates.at(-1)})`;

  console.log("aq download metrics");
  console.log(`Bucket: ${bucket}`);
  console.log(`Period: ${periodLabel}`);
  console.log(`Events: ${events.length}`);

  printSection("Totals");
  console.log(`Install script:  ${totals.install}`);
  console.log(`Tarballs:        ${totals.tarball}`);
  if (totals.install > 0) {
    const ratio = ((totals.tarball / totals.install) * 100).toFixed(1);
    console.log(`Tarball/install: ${ratio}%`);
  }

  printSection("Tarballs by asset");
  for (const [asset, count] of topEntries(byAsset)) {
    if (asset.endsWith(".tar.gz")) {
      console.log(`  ${asset.padEnd(24)} ${count}`);
    }
  }

  printSection("By day");
  for (const [day, count] of topEntries(byDay, 999)) {
    const install = byKindDay.get(`${day}:install`) ?? 0;
    const tarball = byKindDay.get(`${day}:tarball`) ?? 0;
    console.log(`  ${day}  total ${String(count).padStart(4)}  install ${String(install).padStart(4)}  tarball ${String(tarball).padStart(4)}`);
  }

  printSection("Top countries");
  for (const [country, count] of topEntries(byCountry, 8)) {
    console.log(`  ${country.padEnd(8)} ${count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
