/** Proxy axi install.sh + /releases/axi-* → R2. aq ships from GitHub Releases. */

const RELEASES_PREFIX = "/releases/";
/** path → R2 object key (axi only; aq moved to GitHub) */
const INSTALL_KEYS: Record<string, string> = {
  "/axi/download/install.sh": "axi/install.sh",
};
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

const AQ_MOVED =
  "aq installs moved to GitHub Releases: https://github.com/Aquinf03/aq/releases/latest/download/install.sh\n";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (
      path === "/aq/download/install.sh" ||
      path === "/framework/install.sh" ||
      (path.startsWith(RELEASES_PREFIX) && path.slice(RELEASES_PREFIX.length).startsWith("aq-"))
    ) {
      return new Response(AQ_MOVED, {
        status: 410,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Location: "https://github.com/Aquinf03/aq/releases/latest/download/install.sh",
        },
      });
    }

    const installKey = INSTALL_KEYS[path];
    if (installKey) {
      return serveR2(
        request,
        env,
        ctx,
        installKey,
        path,
        "install",
        "text/x-shellscript; charset=utf-8",
      );
    }

    if (!path.startsWith(RELEASES_PREFIX)) {
      return new Response("Not found", { status: 404 });
    }

    const key = path.slice(RELEASES_PREFIX.length);
    if (!key || key.includes("..") || !key.startsWith("axi-")) {
      return new Response("Not found", { status: 404 });
    }

    return serveR2(request, env, ctx, key, path, "tarball");
  },
};
