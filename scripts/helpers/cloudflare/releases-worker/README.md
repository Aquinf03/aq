# axi releases (R2 + Worker)

**aq** no longer uses this worker. Install and tarballs ship from
[GitHub Releases](https://github.com/Aquinf03/aq/releases):

```bash
curl -fsSL https://github.com/Aquinf03/aq/releases/latest/download/install.sh | bash
```

Publish aq with `scripts/helpers/release.sh` (`gh` CLI).

---

This Worker still serves **axi** install + tarballs from R2:

| URL | Notes |
|-----|--------|
| `https://aquin.app/axi/download/install.sh` | Site static / rewrite |
| `https://aquin.app/releases/axi-latestv.tar.gz` | Via Next rewrite → Worker |
| `https://releases.aquin.app/...` | Direct Worker host |

R2 keys: `axi/install.sh`, `axi-*v.tar.gz`.

## Deploy

```bash
cd scripts/helpers/cloudflare/releases-worker
npm i
npx wrangler deploy
```

aq paths (`/aq/download/install.sh`, `/releases/aq-*`) return **410** with a pointer to GitHub.
