# Non-goals

The flip side of `README.md`'s capabilities table. These are things
Stratos **deliberately does not do** — knowing what's out of scope helps
contributors aim PRs at things that will actually merge, and helps
prospective users decide whether Stratos is the right tool for them.

A non-goal can move to a goal, but the proposer should expect to argue
for it: open an issue, name the gap it closes, name the existing tools
that already solve it well, and make the case that Stratos doing it
*additionally* is worth the design cost. Adding a non-goal requires
maintainer sign-off; see [`GOVERNANCE.md`](./GOVERNANCE.md).

Last updated for v0.0.16.

## Architecture

### Runtime dependencies

Stratos ships as a single Node ESM file with zero runtime dependencies.
Every line of every dependency would also be a line a security review
would have to read. The cost of "just one dep" compounds.

If you find yourself wanting `lodash`, `axios`, `chalk`, `commander`,
`yargs`, or any other widely-used utility — the answer is no. Use the
Node standard library or do without.

**Exception:** `devDependencies` are fine (c8 for coverage, etc.). Nothing
in `dependencies`.

### A build step

`stratos.mjs` is the file. No transpiler, no bundler, no `dist/`. If
something requires a build step (TypeScript, JSX, esbuild), it doesn't
belong.

**Exception:** TypeScript declarations (`.d.ts`) generated from JSDoc are
fine — they ship alongside the source, not in place of it.

### A plugin loader

We will not add a runtime plugin system that reads from `~/.stratos/plugins/`
or anywhere else. The extensibility story is the exported programmatic API
(`import { cmdHealth } from '@cloudcdn/stratos'`) — compose Stratos from
your own Node script if you need something Stratos doesn't ship.

## Feature breadth

### Multi-cloud / multi-CDN

Stratos talks to CloudCDN. It is not — and will never be — a generic CDN
abstraction layer. If you need to drive Cloudflare, Fastly, Akamai, AWS
CloudFront, and CloudCDN with the same CLI, that's a different project.
The reason: every CDN's primitives differ enough that the abstraction
either loses fidelity or becomes ten-thousand-line spaghetti.

### A local-emulation simulator of the entire CloudCDN platform

`stratos dev` (Phase 2 of the implementation plan) provides a mock HTTP
endpoint adequate for offline CI smoke tests and the inner loop. It does
**not** simulate every behaviour of the production edge — image transforms,
real-time-log fan-out, AI vision models, edge function execution. If your
team needs full-fidelity local development, point Stratos at a staging
environment instead.

### Edge function deployments

Cloudflare Workers, Fastly Compute, Vercel Edge, AWS Lambda@Edge — each
already has a first-party CLI. Stratos will not grow `stratos deploy`
that targets one of those runtimes. CloudCDN edge functions, if/when they
exist as a product, are a separate scope decision.

### DNS, certificates, WAF

CloudCDN doesn't own the DNS namespace, and CloudCDN's TLS termination is
managed-only today. There is no `stratos dns` / `stratos certs` /
`stratos waf`. If/when CloudCDN exposes management APIs for these, the
non-goal is revisited.

### A TUI / interactive dashboard

Stratos is a one-shot, flag-driven CLI optimised for scripts and agents.
A `stratos ui` mode (ncurses / Charm-style) is interesting but explicitly
not on the roadmap before v1.0.0. The CLI's text and JSON output is
designed to be machine-piped; a TUI competes with rather than complements
that.

### Localisation (i18n / l10n)

All strings are English-only and will stay that way through the v0.0.x
series. The single-file zero-dep design makes a translation infrastructure
disproportionately expensive.

### Phone-home / telemetry

Stratos does not phone home. Not for usage statistics, not for
update-availability polling, not for crash reports, not opt-in or
opt-out. If you want command-level metrics, point `--otlp-endpoint` at
your own collector.

### Auto-update from the CLI

`stratos upgrade` re-runs the pinned installer (your choice of package
manager). It does not silently fetch and replace the binary, and it does
not poll for new versions in the background. Updating is an explicit user
action.

### A backwards-compatibility shim for v0.0.x

Every release in the `v0.0.x` series can break. The versioning policy
([`CHANGELOG.md`](./CHANGELOG.md)) is explicit. Stratos will not carry
deprecation shims that exist solely to preserve a behaviour from v0.0.<N-3>.
When the project reaches v1.0.0, the SemVer contract starts; until then,
read the CHANGELOG before upgrading.

## Distribution & install

### Per-OS packages beyond the ones we already ship

We ship npm, Homebrew tap, Scoop bucket, winget, GitHub release binaries
(5 arches), Docker, `install.sh`, `install.ps1`. Phase 4 of the
implementation plan adds Nix flake, mise plugin, and asdf plugin. We will
not add Snap, Flatpak, Chocolatey, MacPorts, FreeBSD ports, NixOS module,
deb, rpm, or AUR. If you need one of those, the GitHub-release binary or
the `install.sh` already covers it; a well-maintained packaging fork is
also welcome.

### A self-contained Electron desktop app

Not happening.

## Process

### Approval-by-committee for routine changes

See [`GOVERNANCE.md`](./GOVERNANCE.md). Routine PRs need one
maintainer-or-deputy review and green CI, not a vote.

### Synchronous decision meetings

All technical discussion happens in the issue tracker, in writing, in
public. If we ever do a maintainer call, the outcome is captured in an
issue.

## What to do if you really want something on this list

1. Open an issue titled `non-goal-reconsider: <topic>`
2. Explain what changed in the ecosystem since the non-goal was added
3. Name the closest existing tool that already solves the problem; explain
   why Stratos doing it is meaningfully better
4. Be prepared to write the code and own the maintenance burden

The maintainer takes these seriously when they're well-argued. Most are
declined — that's the point of the file.
