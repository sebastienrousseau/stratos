# Migrating from Wrangler to Stratos

If you already use `wrangler` (Cloudflare Workers / Pages) you know the
shape. Stratos is the equivalent for the CloudCDN control plane. This page
lines up the commands you reach for daily so you can copy-paste.

## Mental model

| Wrangler concept | Stratos concept |
|---|---|
| Account ID + API token (`CLOUDFLARE_API_TOKEN`) | `CLOUDCDN_ACCOUNT_KEY` (control) + `CLOUDCDN_ACCESS_KEY` (read) |
| `wrangler.toml` | `~/.config/stratos/config.json` (named profiles) |
| `wrangler login` (OAuth → token file) | `stratos login` (prompts → OS keychain) |
| `wrangler whoami` | `stratos login status` |
| `wrangler tail` | `stratos logs tail` |
| `wrangler dev` (local) | n/a — Stratos is API-only; use `CLOUDCDN_URL=…` |
| `wrangler deploy` | (CloudCDN deploys via Git push; Stratos does the *cache* side) |

## Day-to-day mappings

### Cache & content

| Wrangler | Stratos |
|---|---|
| `wrangler kv key put … --binding=…` | `stratos storage put <local> <remote>` |
| `wrangler r2 object put <bucket>/<key> --file=…` | `stratos storage put <file> <remote>` |
| `wrangler r2 object get <bucket>/<key>` | `stratos storage get <remote>` |
| `wrangler r2 object delete <bucket>/<key>` | `stratos storage rm <remote>` |
| *(no first-class cache purge in core wrangler — needs API token + curl)* | `stratos purge <url>...` / `--tag` / `--everything` |
| *(custom)* | `stratos storage sync ./dist /sites/acme --concurrency 16` |

### Observability

| Wrangler | Stratos |
|---|---|
| `wrangler tail` | `stratos logs tail` |
| `wrangler tail --search=…` | `stratos logs tail --level error \| grep …` |
| `wrangler analytics-engine query …` | `stratos analytics query [...]` |
| *(needs Cloudflare dashboard)* | `stratos insights summary --days 30` |
| *(needs dashboard)* | `stratos insights top --limit 20 --days 30` |
| *(needs dashboard)* | `stratos insights geo --days 7` |
| *(needs API token)* | `stratos audit --action token.create --days 7` |

### Configuration

| Wrangler | Stratos |
|---|---|
| Edit `[env.production]` block in `wrangler.toml` | `stratos config set prod.url …` then `--profile prod` |
| Edit `_headers` / `_redirects`, commit, push | `stratos rules get _headers > local._headers` ; edit ; `stratos rules diff _headers -f local._headers` ; `stratos rules set _headers -f local._headers` |
| `wrangler secret put MY_SECRET` | `stratos tokens create --name "ci" --scopes purge:write` (long-lived, scoped) |
| `wrangler secret list` | `stratos tokens list` |
| `wrangler secret delete MY_SECRET` | `stratos tokens rm <id>` |

### Domains & routing

| Wrangler | Stratos |
|---|---|
| `wrangler custom-domains add <hostname>` | `stratos zones domains add <zone-id> <hostname>` |
| *(via `wrangler.toml` routes)* | `stratos zones list` / `stratos zones create <name>` |
| *(via dashboard)* | `stratos rules set _redirects -f redirects.txt` |

### MCP / AI integration

Both products now ship an MCP-server mode — the workflow is the same shape:

```bash
# Wrangler
wrangler mcp serve

# Stratos
stratos mcp serve
```

Wire either into `~/.claude.json`. Stratos exposes 10 CloudCDN-shaped tools
(`cloudcdn_purge`, `cloudcdn_insights_summary`, `cloudcdn_ai_alt`, …).

## CI patterns

### Cache-bust on deploy (Wrangler equivalent uses dashboard or raw curl)

```yaml
# Stratos in GitHub Actions
- name: Purge cache after deploy
  env:
    CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}
  run: |
    npm i -g @cloudcdn/stratos
    stratos purge --tag "build-${GITHUB_SHA::7}"
```

### Daily smoke test (replaces `wrangler tail` polling)

```yaml
- run: stratos health --deep | jq -e '.bindings | all(. == true)'
```

## Headers/redirects drift detection

Wrangler doesn't ship a built-in diff; you usually `git diff` your local
`_headers` against last commit. With Stratos you can diff *against what's
actually live on the edge* — useful when teams edit via the dashboard:

```bash
stratos rules get _headers > /tmp/remote._headers
diff -u /tmp/remote._headers ./public/_headers
# Or, equivalent and prettier:
stratos rules diff _headers -f ./public/_headers
# Exits 0 if identical, 69 on drift (git-style).
```

## Things Stratos has that Wrangler doesn't

- **AI vision endpoints** — `stratos ai alt|moderate|crop|bg-remove <url>`.
  No Wrangler equivalent; you'd write a Worker that calls the AI binding.
- **Image-transform URL builder** — `stratos image transform <url> --w 800
  --format avif --q 80`. (Wrangler Image Transform is dashboard-only.)
- **`stratos doctor`** — single-command env diagnostic.
- **`stratos bench`** — cold-start + edge-latency snapshot.

## Things Wrangler has that Stratos doesn't

- **Local dev server** — Stratos is API-only; for local CloudCDN testing,
  spin up the dev stack and point `CLOUDCDN_URL` at it.
- **`wrangler deploy`** — CloudCDN deploys assets via Git push, not via CLI.
- **D1 / Queues / Durable Objects** — Cloudflare-specific primitives.

## Cheat sheet

```bash
# Wrangler                                # Stratos
wrangler whoami                           stratos login status
wrangler tail --format=pretty             stratos logs tail
wrangler kv key put                       stratos storage put
wrangler r2 object get                    stratos storage get
wrangler secret put                       stratos tokens create
wrangler mcp serve                        stratos mcp serve
wrangler analytics                        stratos insights summary
```
