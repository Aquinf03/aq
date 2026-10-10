# Framework releases (R2 + Worker)

Packaged `aq` tarballs and the install script live in R2. The Worker serves them from Cloudflare.

## Public URLs (what users hit)

```
https://aquin.app/aq/download/install.sh     # Next.js static (Aquin repo)
https://aquin.app/releases/aq-latestv.tar.gz
https://aquin.app/releases/aq-<version>v.tar.gz
```

Aquin’s `next.config.ts` rewrites `/releases/*` → the Worker origin (see below). Apex/`www` stay on **Vercel**, so they cannot host Worker routes unless you orange-cloud those hostnames through Cloudflare.

## Worker origin (Cloudflare)

| Host | Status |
|------|--------|
| `https://aqfw-releases.aquin-explore.workers.dev` | Live now (always CF) |
| `https://releases.aquin.app` | Preferred; needs DNS (below) |
| `https://aq.aquin.app` | **Deprecated — remove** |

`wrangler.toml` routes:

- `releases.aquin.app/releases/*`
- `releases.aquin.app/framework/install.sh`
- `workers_dev = true`

## One-time: create `releases.aquin.app` DNS

OAuth token from `wrangler login` cannot edit DNS — do this in the Cloudflare dashboard (zone **aquin.app**):

1. **DNS → Add record**
   - Type: **AAAA**
   - Name: `releases`
   - IPv6: `100::`
   - Proxy status: **Proxied** (orange cloud)
2. Wait a minute, then:

   ```bash
   curl -sI https://releases.aquin.app/releases/aq-latestv.tar.gz
   # expect 200, server: cloudflare
   ```

3. In Aquin, set env (optional; defaults to workers.dev until DNS is ready):

   ```
   RELEASES_ORIGIN=https://releases.aquin.app
   ```

4. Redeploy Aquin so `/releases/*` rewrites use that origin.

## Deploy worker

```bash
cd scripts/helpers/cloudflare/releases-worker
npm install
npx wrangler deploy
```

Upload install script (also done by `scripts/helpers/release.sh`):

```bash
wrangler r2 object put releases/framework/install.sh \
  --file=../../../install.sh \
  --content-type "text/x-shellscript; charset=utf-8" \
  --remote
```

## Delete `aq.aquin.app` wholly

After Aquin is live at `aquin.app/aq/` and `/releases/*` rewrites work:

1. **Cloudflare DNS** — delete the `aq` record (A/CNAME/AAAA for `aq.aquin.app`).
2. **Cloudflare Workers** — already removed from `wrangler.toml` (redeployed). Confirm no leftover routes on `aq.aquin.app` in the dashboard.
3. **Vercel** — remove the `aq.aquin.app` domain / old web project if still attached.
4. **Supabase Auth** — Site URL / redirect allowlist: `https://aquin.app` and `https://aquin.app/aq`.
5. **aqfw** — `web/` removed; account UI lives in the Aquin repo at `/aq`.

Do **not** orange-cloud `aquin.app` / `www` onto Cloudflare unless you intentionally want CF in front of Vercel; the rewrite + `releases.aquin.app` pattern avoids that.

## Publish a release

From repo root:

```bash
chmod +x scripts/helpers/release.sh
./scripts/helpers/release.sh latest
./scripts/helpers/release.sh 0.0.2
```

## Team install

```bash
curl -fsSL https://aquin.app/aq/download/install.sh | bash
```

## Download metrics

Each successful download writes JSON under `metrics/events/YYYY-MM-DD/` in the `releases` R2 bucket.
