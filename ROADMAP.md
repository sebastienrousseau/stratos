# Roadmap

Where Stratos's command surface is going, organised by tier. The goal
is to lift Feature Breadth (one of the ten rating axes documented in
`~/Drop/stratos-ip.md`) from the v0.0.20 baseline (~5.5–6/10) into the
9/10 range over the next 12–18 months, gated on CloudCDN's
platform-side API rollout.

Last updated: 2026-06-15, after v0.0.20.

## How to read this file

Each tier groups commands by theme and lists:

- **What ships in Stratos** (the CLI surface)
- **Platform dependency** (the CloudCDN API surface required)
- **Status** — `done`, `shipping in v0.0.X`, `next`, `planned`, or
  `gated on platform`

Tiers 1 and 7 are the only ones that can move without CloudCDN-side
API work; everything else requires platform endpoints. The platform
team has confirmed Tiers 2, 3, 4 are on the CloudCDN roadmap.

## Tier 1 — existing-API completion (no platform changes needed)

Cleans up the gaps where Stratos doesn't yet wrap an API CloudCDN
already exposes.

| Command | Status | Notes |
|---|---|---|
| `stratos rules validate <file>` | ✓ shipped v0.0.20 | Offline; no API call |
| `stratos analytics export --format=parquet --to=s3://…` | next | Bulk export of existing analytics endpoint |
| `stratos audit stream --sink=slack://… \| --sink=datadog://…` | next | Webhook fan-out for audit log |
| `stratos zones backup <id>` / `restore <id> <bundle>` | next | Config snapshot via existing zones API |
| `stratos diff origin <url>` | next | Fetch via edge and via direct origin, line-diff |
| `stratos cache warm <urls>` | planned | Often a hidden API endpoint; confirm with platform |
| `stratos insights costs` | superseded | Now part of `stratos cost` (Tier 7) |

**Total: 6 commands. Lifts Feature Breadth ~5.5/10 → ~6.5/10.**

## Tier 2 — deployments and preview environments

Table-stakes for any credible 2026 CDN/edge CLI (Vercel, Netlify,
Wrangler all have these).

| Command | Status | Platform requirement |
|---|---|---|
| `stratos deploy [path]` | gated | Deployment object with rollback semantics |
| `stratos deployments {list,show,rollback}` | gated | Same |
| `stratos preview {create,list,delete,promote} --branch=foo` | gated | Preview-environment endpoints |
| `stratos traffic split --canary 10% --target=v0.0.20` | gated | Traffic-split routing primitive |
| `stratos env {list,set,get,delete} --env=prod` | gated | Per-environment env-var store |

**8–10 commands. Lifts ~6.5/10 → ~7.5/10. CloudCDN-confirmed
roadmapped; ETA TBD.**

## Tier 3 — edge compute (Workers-equivalent)

| Command | Status | Platform requirement |
|---|---|---|
| `stratos functions {deploy,list,tail,inspect,invoke}` | gated | Edge functions runtime |
| `stratos secrets {list,set,delete} --env=prod` | gated | Function-scoped secrets |
| `stratos bindings {list,add,remove}` | gated | Function → data primitive links |

**8–12 commands. Lifts ~7.5/10 → ~8.0/10. CloudCDN-confirmed
roadmapped.**

## Tier 4 — edge data primitives

The largest single tier by command count. Wrangler dedicates ~30%
of its surface here.

| Command | Status | Platform requirement |
|---|---|---|
| `stratos kv {list,get,set,delete,namespace}` | gated | Key-value store |
| `stratos sql {query,migrate,backup,restore}` | gated | D1-equivalent (SQLite-at-edge) |
| `stratos vector {ingest,search,index}` | gated | Vector store |
| `stratos queue {create,send,subscribe,replay}` | gated | Message queue |
| `stratos r2 {bucket,object,sign}` | partial via `storage` | Object store + presigned URLs |

**10–15 commands. Lifts ~8.0/10 → ~8.5/10. CloudCDN-confirmed
roadmapped (likely KV first, then SQL, then vector + queue).**

## Tier 5 — network security

| Command | Status | Platform requirement |
|---|---|---|
| `stratos waf rules {list,create,update,delete,test}` | planned | WAF policy API |
| `stratos ratelimit rules {list,create,delete}` | planned | Rate-limit rules (separate from WAF) |
| `stratos bots {list,score,classify}` | planned | Bot management |
| `stratos ip {allow,block,query}` | planned | IP allow/block |
| `stratos dns records {list,create,update,delete}` | uncertain | Depends on whether CloudCDN owns DNS |
| `stratos certs {list,upload,renew,revoke}` | planned | Managed TLS API |

**8–10 commands. Lifts ~8.5/10 → ~9.0/10. DNS is the most likely
blocker — typically a separate sub-product.**

## Tier 6 — identity & access

| Command | Status | Platform requirement |
|---|---|---|
| `stratos sso configure --idp=okta\|azure\|google` | planned | OIDC SSO endpoints |
| `stratos roles {list,create,assign}` | planned | RBAC role objects |
| `stratos teams {list,invite,remove}` | planned | Team / sub-account API |
| `stratos tokens federated --duration=1h --scope=…` | planned | Short-lived OIDC-issued tokens |
| `stratos audit who-has-access <resource>` | planned | RBAC introspection |

**5–8 commands. Lifts ~9.0/10 → ~9.2/10.**

## Tier 7 — cost / billing / sustainability (the differentiator)

This is the tier that nobody else in the CDN-CLI space has shipped.
It's the Console.dev / TLDR pitch material per the implementation plan.

| Command | Status | Notes |
|---|---|---|
| `stratos cost [--days N] [--zone Z] [--projected]` | ✓ shipped v0.0.20 | Reads `/api/billing/usage`; projects from `/api/core/statistics` × rate card on fallback |
| `stratos carbon [--days N] [--region X] [--intensity-below N]` | ✓ shipped v0.0.20 | Energy × Electricity Maps grid intensity → gCO2e; `--intensity-below` is the carbon-aware deploy gate |
| `stratos cost project --new-traffic=10x` | next | Scenario projection |
| `stratos quota {get,set,alert}` | planned | Billing alerts |
| `stratos forecast <days>` | planned | Trend-based projection |

**4–6 commands. Lifts ~9.2/10 → ~9.4/10. v0.0.20's two land
~0.4 of this on its own.**

## Tier 8 — compliance and enterprise

| Command | Status | Platform requirement |
|---|---|---|
| `stratos audit export --format=ocsf` | planned | OCSF-formatted export |
| `stratos residency set --region=eu\|us` | planned | Data residency controls |
| `stratos compliance reports {generate,download}` | planned | SOC2 / ISO27001 reports |
| `stratos privacy {forget-user,export-user}` | planned | GDPR right-to-be-forgotten / right-to-export |

**5–8 commands. Lifts ~9.4/10 → ~9.5/10.**

## Visibility-side work (not feature breadth, but cited in the plan)

The implementation plan at `~/Drop/stratos-ip.md` notes that engineering
alone can't move the top-10 readiness rating past ~4/10. The next
12 months of work in parallel with the tiers above:

- Console.dev / TLDR / HN Show launch moment timed to v0.0.20 or v0.0.21
  (cost + carbon are the talkable features)
- MCP-server registry submissions to Anthropic, Cursor, Continue,
  Vercel, Cloudflare
- Recruit 1–2 deputies (DandelionSprout, the contributor of PR #17,
  is the most natural first ask)
- Find 5 named production users; add a `USERS.md`
- Commission a real screencast (not asciinema GIFs)

## How this file gets updated

Every release with a tier-relevant command status change updates this
file in the same PR. The tier headings stay stable so external readers
can bookmark them. New commands within a tier slot in alphabetical
order; status transitions (`planned` → `next` → `shipping` → `done`)
are the main signal worth tracking over time.
