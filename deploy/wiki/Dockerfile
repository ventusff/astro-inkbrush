# The editing machine: node + git only. The site and its content live in a
# named-volume checkout, so the image is a runtime shell.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/wiki/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Starts as root to take ownership of a freshly created named volume, then
# re-execs itself as `node`.
ENTRYPOINT ["/entrypoint.sh"]
