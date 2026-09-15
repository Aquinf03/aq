# Framework releases (R2 + Worker)

Packaged `aq` tarballs and the install script live in R2. A Worker on `aq.aquin.app` serves them and logs download events to R2.

```
https://aq.aquin.app/framework/install.sh
https://aq.aquin.app/releases/aq-latestv.tar.gz
https://aq.aquin.app/releases/aq-<version>v.tar.gz
```

Each successful download writes a small JSON event under `metrics/events/YYYY-MM-DD/` in the same bucket.

## One-time setup

1. Create R2 bucket **`aqfw-releases`** (Cloudflare dashboard → R2).

2. Deploy the worker:

   ```bash
   cd scripts/helpers/cloudflare/releases-worker
   npm install
   npx wrangler deploy
   ```

3. Routes are in `wrangler.toml`:

   - `aq.aquin.app/releases/*`
   - `aq.aquin.app/framework/install.sh`

   Redeploy after changes:

   ```bash
   npx wrangler deploy
   ```

4. Upload the install script once (also done automatically on every release):

   ```bash
   wrangler r2 object put aqfw-releases/framework/install.sh \
     --file=../../../install.sh \
     --content-type "text/x-shellscript; charset=utf-8" \
     --remote
   ```

5. Optional — **Cloudflare Access** on `/releases/*` so only your team can download. Install script stays public; tarball is gated.

6. Optional — create an **R2 API token** with Object Read on `aqfw-releases` to query download metrics locally (see below).

## Publish a release

From repo root:

```bash
chmod +x scripts/helpers/release.sh
./scripts/helpers/release.sh latest          # → aq-latestv.tar.gz
./scripts/helpers/release.sh 0.0.1           # → aq-0.0.1v.tar.gz + updates aq-latestv.tar.gz
```

Uploads tarball(s) and `framework/install.sh`. Requires `wrangler login`.

## Team install

```bash
curl -fsSL https://aq.aquin.app/framework/install.sh | bash
```

Downloads `aq-latestv.tar.gz` from R2 via the Worker, runs `npm install && npm link` in `aq/`.

## Download metrics

The worker logs one JSON object per successful download:

```json
{
  "ts": "2026-09-01T11:22:33.456Z",
  "path": "/releases/aq-latestv.tar.gz",
  "asset": "aq-latestv.tar.gz",
  "kind": "tarball",
  "country": "IN",
  "ua": "curl/8.7.1",
  "status": 200
}
```

Query from your machine with R2 credentials:

```bash
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
# optional: export AQUIN_R2_BUCKET=aqfw-releases

./scripts/helpers/download-metrics.sh
./scripts/helpers/download-metrics.sh --days 7
./scripts/helpers/download-metrics.sh --since 2026-09-01
```

Create the token in Cloudflare → R2 → Manage R2 API Tokens → Object Read on `aqfw-releases`.

Metrics only start accumulating after the updated worker is deployed. Historical downloads before that are not backfilled.
