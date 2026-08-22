# The reader-facing site: a static build served by nginx. No CMS, no
# credentials, no runtime git. Build context: the site repository root.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The base path is baked into every generated href: a sub-path mount sets
# SITE_BASE to /your/prefix/, a root mount leaves it as /.
ARG SITE_BASE=/
ENV SITE_BASE=$SITE_BASE
RUN npm run build

FROM nginx:alpine
# A sub-path mount places the output under a directory of the same name so
# nginx try_files matches without stripping the prefix.
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/static/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
