# Driving CloudCDN from Claude Code (via MCP)

`stratos mcp serve` exposes 10 CloudCDN tools over Model Context Protocol
stdio. Any MCP-compatible host (Claude Code, Cursor, Continue, …) can call
them.

## Configure Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
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

If you prefer to keep credentials out of `claude.json`, omit the `env`
block — the server inherits your shell's environment when Claude Code spawns
it. (Caveat: on macOS the shell that Claude Code spawns may not be the same
one that loaded your dotfiles. Test by asking Claude to call
`cloudcdn_health` and watching for a 401.)

## Tools exposed

| Tool | Maps to |
|---|---|
| `cloudcdn_health` | `stratos health` |
| `cloudcdn_purge` | `stratos purge` (URLs, tags, or everything) |
| `cloudcdn_assets` | `stratos assets` |
| `cloudcdn_insights_summary` | `stratos insights summary` |
| `cloudcdn_insights_top` | `stratos insights top` |
| `cloudcdn_ai_alt` | `stratos ai alt` |
| `cloudcdn_ai_moderate` | `stratos ai moderate` |
| `cloudcdn_search` | `stratos search` |
| `cloudcdn_signed` | `stratos signed` (offline) |
| `cloudcdn_logs_query` | `stratos logs query` |

## Prompts that work well

> "Use the CloudCDN tools to give me the top 20 assets by request count
> over the last 30 days, then check moderation status for any whose path
> contains `user-uploads/`."

> "Generate AI alt-text for every asset returned by
> `cloudcdn_assets({format: 'jpg', project: 'akande'})`. Show me a markdown
> table sorted by asset path."

> "I'm about to deploy. Purge the cache-tag `build-abc1234`, then verify
> with `cloudcdn_health --deep`."

## Debugging

The MCP channel is stdout-only and must stay JSON-RPC clean. If you suspect
something is wrong, run the server directly and pipe a request:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | stratos mcp serve
```

You should see a single JSON response with `serverInfo.name === "stratos"`.

For deeper traces, set `--verbose` *before* `mcp serve` won't work because
the verbose output would corrupt stdout — instead read the server's stderr:

```bash
stratos mcp serve 2>mcp.log < your-input.jsonl > responses.jsonl
```
