# Migrating from Fastly CLI to Stratos

If you live in `fastly` / `fastlyctl`, these are the equivalent Stratos
commands. Fastly v14 (Feb 2026) consolidated everything under `service`
subcommands — Stratos uses noun-first too, so the shape will feel familiar.

## Mental model

| Fastly concept | Stratos concept |
|---|---|
| `FASTLY_API_TOKEN` | `CLOUDCDN_ACCOUNT_KEY` |
| Service ID | Zone name (`stratos zones list`) |
| VCL configuration | `_headers` / `_redirects` rules (Git-backed) |
| Surrogate-Key | Cache-Tag |
| `fastly profile` | `stratos --profile <name>` |
| `fastly logging` | `stratos logs tail` |

## Day-to-day mappings

### Cache invalidation

| Fastly | Stratos |
|---|---|
| `fastly service purge <url>` | `stratos purge <url>` |
| `fastly service purge --key=<surrogate-key>` | `stratos purge --tag <tag>` |
| `fastly service purge --all` | `stratos purge --everything` |
| `fastly service purge --soft` | *(use signed URLs with short TTL instead)* |
| *(scriptable batch via API)* | `cat urls.txt \| stratos purge -` |

### Service / zone management

| Fastly | Stratos |
|---|---|
| `fastly service list` | `stratos zones list` |
| `fastly service create --name=…` | `stratos zones create <name>` |
| `fastly service describe --service-id=…` | `stratos zones show <id>` |
| `fastly service delete --service-id=…` | `stratos zones rm <id> --force` |
| `fastly domain create --name=…` | `stratos zones domains add <zone-id> <hostname>` |

### Tokens & secrets

| Fastly | Stratos |
|---|---|
| `fastly auth-token list` | `stratos tokens list` |
| `fastly auth-token create --scope=…` | `stratos tokens create --name N --scopes S,S` |
| `fastly auth-token delete --id=…` | `stratos tokens rm <id>` |

### Logging & analytics

| Fastly | Stratos |
|---|---|
| `fastly log-tail` | `stratos logs tail` |
| `fastly stats historical --service-id=…` | `stratos stats --days 30` |
| `fastly stats realtime --service-id=…` | `stratos insights summary --days 1` |
| *(needs separate setup)* | `stratos insights top --limit 20 --days 7` |
| *(needs separate setup)* | `stratos insights geo --days 7` |

### Configuration

| Fastly | Stratos |
|---|---|
| `fastly service vcl custom upload` | `stratos rules set _headers -f local._headers` |
| `fastly service vcl custom describe` | `stratos rules get _headers` |
| *(no built-in diff)* | `stratos rules diff _headers -f local._headers` |

### Profiles & env

| Fastly | Stratos |
|---|---|
| `fastly profile create production` | `stratos config set prod.url https://cloudcdn.pro` ; `stratos config set prod.account_key cdnsk_…` |
| `fastly --profile production …` | `stratos --profile prod …` |
| `fastly profile token <name>` | `stratos login` (writes to OS keychain) |

## CI patterns

### Cache invalidation after deploy

```yaml
# Fastly equivalent: fastly service purge --key=$KEY --service-id=$SVC
- name: Cache bust
  env:
    CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}
  run: |
    npm i -g @cloudcdn/stratos
    stratos purge --tag "deploy-${GITHUB_SHA::7}"
```

### Health gate

```yaml
# Fastly: fastly service stats realtime --json | jq …
# Stratos:
- run: stratos health --deep | jq -e '.bindings | all(. == true)'
```

## Concept differences worth flagging

- **No VCL.** CloudCDN's edge config is the much smaller `_headers` and
  `_redirects` files (Cloudflare Pages convention). Anything VCL-shaped
  that you need is either a header rule (cache TTL, security headers,
  rewrites) or unsupported (more complex transforms ship as a separate
  service).
- **Surrogate-Key ≡ Cache-Tag.** Same idea; same usage pattern (`stratos
  purge --tag <t>`).
- **No "soft purge" flag.** Use short-TTL signed URLs (`stratos signed
  <path> --expires …`) for revalidation patterns.
- **Real-time logs are SSE-streamed.** `stratos logs tail` opens a long-
  lived SSE connection; Ctrl-C exits cleanly with code 130.

## Cheat sheet

```bash
# Fastly                                  # Stratos
fastly profile list                       stratos config list
fastly auth-token list                    stratos tokens list
fastly service purge                      stratos purge
fastly service purge --key=k              stratos purge --tag k
fastly service list                       stratos zones list
fastly log-tail                           stratos logs tail
fastly stats historical                   stratos stats --days 30
```

## Things Stratos has that Fastly CLI doesn't

- **MCP server** — `stratos mcp serve` exposes CloudCDN to Claude Code /
  Cursor / any MCP host.
- **AI vision endpoints** — `stratos ai alt|moderate|crop|bg-remove`.
- **`stratos doctor`** and **`stratos bench`** as one-liners.
- **Auto-pagination** via `--all` for `assets`.

## Things Fastly CLI has that Stratos doesn't

- **Compute@Edge / WASM** — Stratos talks to a different platform.
- **VCL editing / linting** — see "no VCL" note above.
- **`fastly dev`** — local dev server.
