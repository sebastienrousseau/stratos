# Migrating from Codex CLI to Stratos

[Codex CLI](https://developers.openai.com/codex/cli) is OpenAI's agent
CLI: terminal-first AI coding with built-in OpenTelemetry, MCP
client/server, profile management, and device-flow auth. Stratos
shipped many of the same posture-level features in 2026 — they aren't
direct alternatives (Codex codes; Stratos drives CloudCDN), but the
shape is so similar that teams asking "do I need both?" deserve a
clear answer.

This guide is for teams that **already** use Codex and now want to
add CloudCDN automation to their agent workflow.

## Mental model

| Codex concept | Stratos concept |
|---|---|
| `codex` (agent CLI) | `stratos` (control-plane CLI) |
| Codex's MCP **server** (`codex mcp serve`) | `stratos mcp serve` |
| Codex's MCP **client** (talks to other MCP servers) | Stratos is *only* an MCP server — point Codex at it |
| `--profile` switches API account + base URL | `--profile` switches CloudCDN account + base URL |
| Device-code login (`codex login --device`) | `stratos login` (OS keychain) — device flow is on the v0.0.6 roadmap |
| Built-in OpenTelemetry (`--otlp-endpoint`) | Built-in OpenTelemetry (`--otlp-endpoint`) |
| `--json` for structured output | `--json` / `--output yaml\|csv\|table` |
| Trusted-publisher npm releases | Trusted-publisher npm releases |
| Build provenance + SBOM in every release | Build provenance + SBOM + VEX in every release |

## "Do I need both?"

Yes, if you use both platforms. Codex is the agent driver; Stratos is
the platform automation. They're complementary, not overlapping.

The clean integration is:

```json
// ~/.codex/config.json  (Codex's MCP client config)
{
  "mcp_servers": {
    "cloudcdn": {
      "command": "stratos",
      "args": ["mcp", "serve"],
      "env": {
        "CLOUDCDN_ACCOUNT_KEY": "cdnsk_…",
        "CLOUDCDN_ACCESS_KEY":  "cdnsk_…"
      }
    }
  }
}
```

Now inside a Codex session you can ask the agent to *use* Stratos as
one of its tools — purge caches, query insights, render BlurHash
placeholders — and Codex's planner handles the orchestration.

## Day-to-day equivalents

### Observability

| Codex | Stratos |
|---|---|
| `codex --otlp-endpoint http://otel:4318` | `stratos --otlp-endpoint http://otel:4318` |
| `OTEL_EXPORTER_OTLP_ENDPOINT=…` (env) | `OTEL_EXPORTER_OTLP_ENDPOINT=…` (env) |
| `OTEL_EXPORTER_OTLP_HEADERS=k=v,k=v` | `OTEL_EXPORTER_OTLP_HEADERS=k=v,k=v` |
| `codex` emits one span per agent run | `stratos` emits one span per command |

Both tools emit OTLP/HTTP JSON. Point them at the same collector for a
single-pane-of-glass view of "Codex agent run → invoked Stratos tool →
hit CloudCDN API".

### Profiles

| Codex | Stratos |
|---|---|
| `codex --profile prod chat …` | `stratos --profile prod purge --tag …` |
| `~/.codex/config.json` profile keys | `~/.config/stratos/config.json` profile keys |
| Profile-scoped device-flow token | Profile-scoped keys (env / file / OS keychain) |

### Output shapes

| Codex | Stratos |
|---|---|
| `--json` returns structured agent results | `--output json` / `--output yaml` / `--output csv` |
| Pipe-friendly NDJSON streaming | Pipe-friendly compact JSON when stdout is non-TTY |

### MCP servers

| Codex | Stratos |
|---|---|
| Codex *is* an MCP client; consumes others' servers | Stratos *is* an MCP server; advertises tools, resources, prompts |
| 10+ tools from CloudCDN are usable from Codex once configured | All Stratos tools auto-available; resources read live API state |

## Concrete recipes

### 1. Let Codex purge CloudCDN cache after a deploy

> codex> I just merged main and the GitHub Actions run finished. Use the
>        cloudcdn tools to purge the cache for `build-${SHA::7}` and check
>        for any 5xx spike afterwards via `cloudcdn://insights/errors`.

Codex will: (a) call `cloudcdn_purge` with the tag, (b) read
`cloudcdn://insights/errors`, (c) summarise.

### 2. Generate alt-text for a project's assets via the agent

The `alt_text_batch` prompt that Stratos exposes was designed for exactly
this. Codex picks it up automatically:

> codex> Run the cloudcdn/alt_text_batch prompt with project=akande and
>        format=jpg. Output the results as a markdown table.

### 3. Single OTel trace for end-to-end

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.internal
export OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer\ ${OTEL_TOKEN}

codex chat "Cache-bust after this deploy"   # codex span: codex.chat
# └─ codex calls cloudcdn_purge → stratos span: stratos purge
# └─ codex reads cloudcdn://insights/errors → stratos span: stratos mcp.resource_read
```

Three spans, single trace, parent-child linked via the OTel context
that Codex propagates to MCP tool calls (per the 2026-07-28 spec
preview).

## Things Codex has that Stratos doesn't

- **Agent loop** — Stratos is one-shot per command; you orchestrate.
- **Computer use** — Stratos doesn't drive your desktop.
- **Multi-turn conversation memory** — Stratos has no session state.

## Things Stratos has that Codex doesn't

- **`cloudcdn://…` resources** — Stratos's MCP resources let an agent
  *read* live CloudCDN state without invoking a tool roundtrip.
- **`stratos doctor` / `stratos bench` / `stratos explain`** — Codex
  is general; Stratos is specifically tuned for CloudCDN operability.
- **Single-binary distribution** — `stratos-{linux,darwin,win}-{x64,arm64}`
  artefacts attached to every GitHub release; no runtime needed.
- **`--output yaml | csv`** — Codex is JSON-only.

## Cheat sheet

```
# Codex                                       # Stratos
codex mcp serve                               stratos mcp serve
codex --profile prod                          stratos --profile prod
codex --otlp-endpoint http://collector        stratos --otlp-endpoint http://collector
codex --json                                  stratos --output json
codex login --device                          stratos login   # (device flow → v0.0.6)
codex extension list                          stratos completion ... # (extensions → v0.0.6)
```
