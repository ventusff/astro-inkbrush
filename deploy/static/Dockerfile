# The reader-facing site: a static build served by nginx. No CMS, no
# credentials, no runtime git. Build context: the site repository root.
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Reproducible install selected by the lockfile present: pnpm-lock.yaml →
# pnpm --frozen-lockfile, package-lock.json → npm ci; no lockfile is an error.
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then \
        corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund; \
    else \
        echo "no lockfile: commit package-lock.json or pnpm-lock.yaml" >&2; exit 1; \
    fi
COPY . .
# The base path is baked into every generated href: a sub-path mount sets
# SITE_BASE to /your/prefix/, a root mount leaves it as /.
ARG SITE_BASE=/
ENV SITE_BASE=$SITE_BASE
RUN npm run build
# A sub-path mount serves the build under the same prefix inside the web
# root, so nginx try_files matches without stripping the prefix; a root
# mount stages it at the web-root top level.
RUN mkdir -p "/site${SITE_BASE%/}" && cp -a dist/. "/site${SITE_BASE%/}/"

FROM nginx:alpine
COPY --from=build /site /usr/share/nginx/html
COPY deploy/static/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
