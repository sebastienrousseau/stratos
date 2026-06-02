# Setting up the `homebrew-cloudcdn` tap (one-off, ~10 min)

Stratos's `release.yml` already produces a Homebrew Formula (`dist/stratos.rb`)
on every tagged release and attaches it to the GitHub Release. To make
`brew install stratos` work end-to-end, you need a tap repository to
host that Formula. Here's the one-time setup.

## 1. Create the tap repo

GitHub conventionally names tap repos `homebrew-<scope>`. For
CloudCDN, that's `homebrew-cloudcdn`.

```bash
gh repo create sebastienrousseau/homebrew-cloudcdn \
  --public \
  --description "Homebrew tap for CloudCDN — Stratos and friends" \
  --add-readme
```

## 2. Drop the initial Formula in

```bash
git clone https://github.com/sebastienrousseau/homebrew-cloudcdn.git
cd homebrew-cloudcdn
mkdir -p Formula

# Pull the Formula from the most recent Stratos release.
gh release download --repo sebastienrousseau/stratos --pattern 'stratos.rb' --output Formula/stratos.rb

# The Formula contains REPLACE_WITH_*_SHA placeholders that brew
# expects to be real sha256 sums. Compute them from the live release.
VERSION=$(gh release view --repo sebastienrousseau/stratos --json tagName | jq -r '.tagName' | sed 's/^v//')
BASE=https://github.com/sebastienrousseau/stratos/releases/download/v$VERSION
for arch in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  SHA=$(curl -fsSL "$BASE/stratos-$arch" | sha256sum | cut -d' ' -f1)
  KEY=$(echo $arch | tr '[:lower:]-' '[:upper:]_')_SHA
  sed -i.bak "s/REPLACE_WITH_${KEY}/$SHA/" Formula/stratos.rb
done
rm Formula/stratos.rb.bak

git add Formula/stratos.rb
git commit -s -S -m "stratos $VERSION"
git push
```

## 3. Users can now install

```bash
brew tap sebastienrousseau/cloudcdn
brew install stratos
stratos version
```

## 4. Automate the bump per release (optional)

Add a workflow to `homebrew-cloudcdn` that fires on a Stratos release:

```yaml
# .github/workflows/bump.yml in sebastienrousseau/homebrew-cloudcdn
name: bump
on:
  repository_dispatch:
    types: [stratos-release]
  workflow_dispatch:
    inputs:
      version:
        required: true

permissions:
  contents: write

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          set -e
          VERSION="${{ github.event.client_payload.version || github.event.inputs.version }}"
          BASE="https://github.com/sebastienrousseau/stratos/releases/download/v$VERSION"
          gh release download --repo sebastienrousseau/stratos "v$VERSION" \
            --pattern 'stratos.rb' --output Formula/stratos.rb
          for arch in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
            SHA=$(curl -fsSL "$BASE/stratos-$arch" | sha256sum | cut -d' ' -f1)
            KEY=$(echo $arch | tr '[:lower:]-' '[:upper:]_')_SHA
            sed -i "s/REPLACE_WITH_${KEY}/$SHA/" Formula/stratos.rb
          done
          git config user.name 'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add Formula/stratos.rb
          git commit -m "stratos $VERSION"
          git push
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

And add a dispatch step to Stratos's `release.yml` that POSTs
`repository_dispatch` to the tap on each release. (Not wired in by
default because it requires a cross-repo PAT — `secrets.GITHUB_TOKEN`
can't reach across.)

## Why a separate repo?

Homebrew's tap discovery requires the `homebrew-<scope>` naming and a
`Formula/<name>.rb` layout. Keeping the Formula generation in the
Stratos repo (as it is now) decouples release timing from tap
maintenance — the Formula is always produced on every tag, but the
tap repo can be added/bumped at any pace.
