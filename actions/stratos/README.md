<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="https://cloudcdn.pro/stratos/v1/logos/stratos.svg" alt="Stratos logo" width="128" />
</p>

<h1 align="center"><code>stratos</code> composite GitHub Action</h1>

<p align="center">
  Run the official <a href="https://cloudcdn.pro">CloudCDN</a> CLI from any
  GitHub Actions workflow without the <code>npm install -g</code> step.
  Same single-file ESM, same exit codes, same provenance — wrapped for the
  runner matrix.
</p>

<p align="center">
  <a href="https://github.com/sebastienrousseau/stratos/actions"><img src="https://img.shields.io/github/actions/workflow/status/sebastienrousseau/stratos/ci.yml?style=for-the-badge&logo=github" alt="Build" /></a>
  <a href="https://github.com/sebastienrousseau/stratos/releases"><img src="https://img.shields.io/github/v/release/sebastienrousseau/stratos?style=for-the-badge&color=fc8d62" alt="Release" /></a>
  <a href="https://github.com/marketplace/actions/stratos"><img src="https://img.shields.io/badge/marketplace-stratos-2088FF?style=for-the-badge&logo=githubactions&logoColor=white" alt="Marketplace" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="MIT" /></a>
</p>

---

The action transparently picks the cheapest install channel for the
host — prebuilt single binary on the common Linux / macOS / Windows
combinations, npm everywhere else — so the same step works across the
runner matrix.

## Contents

- [Quick start](#quick-start)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Authentication](#authentication)
- [Recipes](#recipes)
- [Pinning](#pinning)
- [How it works](#how-it-works)

---

## Quick start

```yaml
- uses: sebastienrousseau/stratos/actions/stratos@v0.0.8
  with:
    command: purge --tag build-${{ github.sha }}
  env:
    CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}
```

---

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `command` | yes | — | CLI args to pass to `stratos`. Example: `purge --tag build-abc1234`, `assets --project=akande --output json`. |
| `version` | no | matches the pinned ref | Stratos version to install. Override with e.g. `version: 0.0.8`. |
| `output`  | no | `''` | Output format hint forwarded as `--output`. One of `json` / `yaml` / `csv` / `table`. |

## Outputs

| Name | Description |
|---|---|
| `stdout` | Captured stdout from the command (works for multi-line output). |
| `exit-code` | Exit code from the CLI invocation. |

---

## Authentication

Same env vars as every other Stratos channel — set them at the step or
job level. The action runs with `STRATOS_CI=1` so CI auto-defaults
(`--json --quiet`, GitHub workflow command framing) kick in
automatically.

```yaml
env:
  CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}   # control-plane ops
  CLOUDCDN_ACCESS_KEY:  ${{ secrets.CLOUDCDN_ACCESS_KEY }}    # read-only ops
  SIGNED_URL_SECRET:    ${{ secrets.SIGNED_URL_SECRET }}      # for `signed`
```

---

## Recipes

### Cache invalidation after a deploy

```yaml
- uses: sebastienrousseau/stratos/actions/stratos@v0.0.8
  with:
    command: purge --tag build-${{ github.sha }}
  env:
    CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}
```

### Health smoke test in a workflow

```yaml
- id: health
  uses: sebastienrousseau/stratos/actions/stratos@v0.0.8
  with:
    command: health --deep
    output: json
- run: echo "${{ fromJSON(steps.health.outputs.stdout).status }}"
```

### Drift detection on `_headers`

```yaml
- uses: sebastienrousseau/stratos/actions/stratos@v0.0.8
  with:
    command: rules diff _headers -f ./public/_headers
  env:
    CLOUDCDN_ACCOUNT_KEY: ${{ secrets.CLOUDCDN_ACCOUNT_KEY }}
  continue-on-error: true   # exit 69 on drift is informational
```

---

## Pinning

`@v0.0.8` pins to a tag. The action and the CLI ship from the same repo,
so the tag pins both. To get a newer Stratos than the action default,
pass `with: version: <semver>` explicitly.

---

## How it works

1. **Detect host** — `$RUNNER_OS-$RUNNER_ARCH` is mapped to one of the
   five prebuilt single-binary assets.
2. **Install single binary** — `curl -fsSL` from the matching GitHub
   Release asset, dropped into `$RUNNER_TEMP` and added to `$PATH`.
3. **Fall back to npm** if the host isn't covered (rare).
4. **Run the command** with `STRATOS_CI=1`, capture stdout/stderr, set
   the `stdout` + `exit-code` outputs, propagate the exit code so the
   step fails the workflow naturally on a non-zero exit.

---

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
