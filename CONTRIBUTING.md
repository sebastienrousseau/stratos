# Contributing to Stratos

Thank you for considering a contribution. Stratos is a small, focused CLI
with a strong "zero dependencies, single file" ethos. The bar for new code
is **does it deserve to be in the only file every user runs?**

## Ground rules

1. **No runtime dependencies.** Every line ships to every user. Use the
   Node ≥ 20 standard library or do not need the dependency.
2. **One file: `stratos.mjs`.** Split into `lib/*.mjs` only when the file
   passes ~2000 LoC and a clean seam exists.
3. **Tests are required.** Every new command needs at least one test in
   `test/`. Use the in-process mock HTTP server for integration tests.
4. **Errors to stderr, machine output to stdout.** Always. Pipelines depend
   on this contract.
5. **Sysexits-style exit codes.** See `EX` in `stratos.mjs`.
6. **Conventional Commits.** `feat: …`, `fix: …`, `docs: …`, `test: …`,
   `refactor: …`, `chore: …`. Breaking changes use `feat!:` and a
   `BREAKING CHANGE:` footer.

## Development setup

```bash
git clone https://github.com/sebastienrousseau/stratos
cd stratos
node --version   # must be ≥ 20

# Run the suite (zero dependencies)
npm test

# Run the CLI from source
node stratos.mjs version
node stratos.mjs help

# Test against a local CloudCDN edge
CLOUDCDN_URL=http://localhost:8788 node stratos.mjs health
```

## Adding a command

1. Pick the right namespace (`zones`, `storage`, `ai`, …). Avoid top-level
   verbs unless the noun has no obvious home.
2. Write the command body in `stratos.mjs`. Keep it ≤ 30 LoC. Use
   `getJson()` for GETs that share auth policy.
3. Add the command to the router `switch` in `main()`.
4. Add a one-line entry to `HELP_ROOT` and (if non-trivial) an entry to
   `HELP_BY_COMMAND` for `stratos <cmd> --help`.
5. Add the command name to the `COMMANDS` array in `cmdCompletion()` so
   tab completion picks it up.
6. Write at least one test:
   - Pure parsing/formatting goes in `test/parse.test.mjs`.
   - HTTP behaviour goes in `test/http.test.mjs` using `withServer()`.
   - HMAC / cryptography goes in `test/signed.test.mjs`.
7. If the command should be exposed to AI hosts, add it to `MCP_TOOLS` and
   wire it into `mcpCall()`. Add an MCP test.
8. Update `README.md` (the commands table) and `CHANGELOG.md` (under
   `## [Unreleased]`).

## What we will reject

- **Anything that adds a dependency** — unless it's a Node-stdlib import.
- **Output to stdout for diagnostics.** Info, warnings, and errors go to
  stderr. The only thing on stdout is what the user wants to pipe.
- **Default-on behaviour that phones home.** Even an opt-out telemetry
  ping is out of scope.
- **Implicit credentials reads.** If you need a key, declare which env var
  / flag / profile field the user must set.
- **Untested code.** Mock servers are cheap (see `test/http.test.mjs`).

## Reviewing your own PR before submitting

- [ ] `npm test` passes locally on Node 20 *and* 22.
- [ ] No new files outside `stratos.mjs`, `test/`, `install/`, `examples/`,
      `.github/`, top-level docs.
- [ ] No `console.log` left behind. Use `out()`, `info()`, `warn()`, `fatal()`.
- [ ] No `node:` import that requires Node > 20.
- [ ] `CHANGELOG.md` has an entry for user-visible changes.
- [ ] If the change is breaking, the entry says **why** and provides a
      migration line.
- [ ] If you added a flag, it is documented in `README.md`'s global-options
      table or the relevant command row.

## Releasing

Maintainers only.

1. Verify CI is green on `main`.
2. Bump `VERSION` in `stratos.mjs`, `version` in `package.json`, and add
   the dated entry in `CHANGELOG.md`.
3. Recompute the pinned hash:
   ```bash
   shasum -a 256 stratos.mjs
   ```
4. Update `EXPECTED_SHA` in `install/install.sh` and `install/install.ps1`.
5. Commit: `release: stratos v<x.y.z>`.
6. Tag: `git tag -s v<x.y.z> -m 'v<x.y.z>'`.
7. Push: `git push --follow-tags`. The `release.yml` workflow handles
   `npm publish --provenance` and GitHub release artefacts.

## Code of conduct

Be patient, be specific, be kind. Disagreements about technical direction
get resolved in the issue tracker, in public, with concrete examples.
