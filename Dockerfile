# SPDX-License-Identifier: MIT
#
# Multi-arch Docker image for Stratos. Mirrors the npm install path:
# a thin Node 24 base layer with the single ES module installed at
# `/usr/local/lib/stratos/stratos.mjs` and a `stratos` shim at
# `/usr/local/bin/stratos`. Zero runtime dependencies.
#
# Build:   docker build -t stratos .
# Run:     docker run --rm stratos version
# Tagging: handled by .github/workflows/release.yml on each v* tag.

FROM node:24-alpine

# Lay down stratos.mjs verbatim — no `npm install` needed because there
# are no runtime dependencies. The image is exclusively the runtime
# (Node) + the script.
COPY stratos.mjs /usr/local/lib/stratos/stratos.mjs

# Tiny shim so users can run `stratos <cmd>` or `docker run ... <cmd>`
# without spelling out `node /usr/local/lib/stratos/stratos.mjs`.
RUN printf '#!/bin/sh\nexec node /usr/local/lib/stratos/stratos.mjs "$@"\n' \
      > /usr/local/bin/stratos \
    && chmod +x /usr/local/bin/stratos \
    && stratos version

# Run as an unprivileged user. Node's official alpine image already
# defines `node:1000`.
USER node

ENTRYPOINT ["stratos"]
CMD ["help"]
