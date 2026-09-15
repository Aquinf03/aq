/** Proxy /releases/* and /framework/install.sh on aq.aquin.app → R2; log downloads. */

const RELEASES_PREFIX = "/releases/";
const INSTALL_PATH = "/framework/install.sh";
const INSTALL_KEY = "framework/install.sh";
const METRICS_PREFIX = "metrics/events/";

export interface Env {
  RELEASES: R2Bucket;
}

type DownloadKind = "install" | "tarball";

interface DownloadEvent {
  ts: string;
  path: string;
  asset: string;
  kind: DownloadKind;
  country: string | null;
  ua: string | null;
  status: number;
}

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

function requestCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  return cf?.country ?? null;
}

async function logDownload(env: Env, event: DownloadEvent): Promise<void> {
  const key = `${METRICS_PREFIX}${utcDate(event.ts)}/${crypto.randomUUID()}.json`;
  await env.RELEASES.put(key, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function serveR2(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key: string,
  path: string,
  kind: DownloadKind,
  contentTypeOverride?: string,
): Promise<Response> {
  const object = await env.RELEASES.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  ctx.waitUntil(
    logDownload(env, {
      ts: new Date().toISOString(),
      path,
      asset: key.includes("/") ? (key.split("/").pop() ?? key) : key,
      kind,
      country: requestCountry(request),
      ua: request.headers.get("user-agent"),
      status: 200,
    }),
  );

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Access-Control-Allow-Origin", "*");
  if (contentTypeOverride && !headers.has("Content-Type")) {
    headers.set("Content-Type", contentTypeOverride);
  }

  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === INSTALL_PATH) {
      return serveR2(
        request,
        env,
        ctx,
        INSTALL_KEY,
        path,
        "install",
        "text/x-shellscript; charset=utf-8",
      );
    }

    if (!path.startsWith(RELEASES_PREFIX)) {
      return new Response("Not found", { status: 404 });
    }

    const key = path.slice(RELEASES_PREFIX.length);
    if (!key || key.includes("..")) {
      return new Response("Bad path", { status: 400 });
    }

    return serveR2(request, env, ctx, key, path, "tarball");
  },
};
