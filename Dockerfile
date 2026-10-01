# odoo-trace-kit — container image for Ubuntu 24.04 hosts.
#
#   docker compose build
#   docker compose run --rm tracekit test
#   docker compose run --rm -T tracekit trace SMOKE http://host.docker.internal:8069/web/login < flows/login-only.txt
#
# The base image ships Chromium for exactly this Playwright release, so the tag
# MUST match the version pinned in package-lock.json (checked below).
ARG PLAYWRIGHT_VERSION=1.61.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}

# Thai fonts: without them every Thai label in a screenshot renders as boxes.
# python3 runs the static checks and the observer tests; curl is used by
# run-tests.sh to probe for a live Odoo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fontconfig fonts-thai-tlwg fonts-noto-core python3 curl \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
RUN if ! fc-list :lang=th family | grep -q .; then echo "no Thai font installed" >&2; exit 1; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && node -e "const v=require('playwright/package.json').version; \
      if (v !== process.env.PLAYWRIGHT_VERSION) { \
        console.error('package-lock has playwright ' + v + ' but the image is built for ' + process.env.PLAYWRIGHT_VERSION + ' — bump PLAYWRIGHT_VERSION'); \
        process.exit(1); }"

COPY . .

# Artifacts and login sessions live on the /data volume, never in the image.
ENV TRACE_OUT_DIR=/data/traces \
    TRACE_SESSION_DIR=/data/sessions \
    TRACEKIT_STATE_DIR=/data/runtime
RUN mkdir -p /data/traces /data/sessions /data/runtime \
 && chown -R pwuser:pwuser /data /app

USER pwuser

# Gate the build on the kit's own static and unit tests. The browser smoke test
# needs a live Odoo and skips itself here.
RUN ./run-tests.sh http://127.0.0.1:9

VOLUME ["/data"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["help"]
