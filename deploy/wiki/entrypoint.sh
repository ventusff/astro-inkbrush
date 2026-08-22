#!/bin/sh
# Container entry for the editing machine: clone or update the site repo in
# the volume, install the machine's CMS config and credentials, install
# dependencies from the lockfile, run the permanent WIKI dev server.
#
# Inputs (service environment):
#   REPO_URL              the site repository (SSH or HTTPS)             required
#   REPO_BRANCH           branch to track                                 default main
#   CONTENT_DIR           note content tree, relative to the repo root    default src/content
#   ENGINE_PATH           the astro-inkbrush submodule path               default vendor/astro-inkbrush
#   BOT_SSH_KEY_B64       base64 private key for git over SSH             required
#   INKBRUSH_CONFIG_B64   base64 inkbrush.config.ts for this machine      required
#   SAML_IDP_CERT_B64     base64 IdP signing certificate (public)         optional
#   SITE_BASE             Astro base path                                 default /
#   GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL                              optional
#
# Failure policy: every step that decides whether edits reach git — the key,
# the config, the pull — fails the container rather than serving a state that
# silently loses work.
set -eu

D=/repo/site
BRANCH=${REPO_BRANCH:-main}
CONTENT_DIR=${CONTENT_DIR:-src/content}
ENGINE_PATH=${ENGINE_PATH:-vendor/astro-inkbrush}

# A named volume is created root-owned; the server runs as `node`. Take
# ownership once, as root, then re-exec as node.
if [ "$(id -u)" = "0" ]; then
    mkdir -p /repo
    chown node:node /repo
    exec su node -s /bin/sh -c "exec $0"
fi
git config --global --add safe.directory "$D"
git config --global --add safe.directory "$D/$ENGINE_PATH"

# Credentials and config are decoded from the environment into files that only
# this user can read.
umask 077
if [ -n "${BOT_SSH_KEY_B64:-}" ]; then
    printf '%s' "$BOT_SSH_KEY_B64" | base64 -d > /tmp/bot-key
    export GIT_SSH_COMMAND="ssh -i /tmp/bot-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts"
    echo "[entrypoint] bot key installed"
else
    echo "[entrypoint] FATAL: BOT_SSH_KEY_B64 unset — no git over SSH." >&2
    exit 1
fi
if [ -n "${SAML_IDP_CERT_B64:-}" ]; then
    printf '%s' "$SAML_IDP_CERT_B64" | base64 -d > /tmp/idp-cert.pem
    echo "[entrypoint] IdP certificate installed at /tmp/idp-cert.pem"
fi
umask 022

if [ ! -d "$D/.git" ]; then
    echo "[entrypoint] cloning into the volume ..."
    git clone --single-branch --branch "$BRANCH" "${REPO_URL:?set REPO_URL}" "$D"
fi
git -C "$D" config user.name  "${GIT_COMMITTER_NAME:-wiki-editor}"
git -C "$D" config user.email "${GIT_COMMITTER_EMAIL:-wiki@example.com}"
git -C "$D" remote set-url origin "${REPO_URL:?set REPO_URL}"

# Uncommitted note edits in the volume are the CMS's own saves that did not
# reach git; they are committed before the update so the pull cannot lose
# them. Lockfile drift from an earlier install is restored.
git -C "$D" checkout -q -- ':(glob)**/package-lock.json' ':(glob)**/pnpm-lock.yaml' 2>/dev/null || true
if [ -n "$(git -C "$D" status --porcelain -- "$CONTENT_DIR")" ]; then
    echo "[entrypoint] uncommitted edits under $CONTENT_DIR — committing them before the update:" >&2
    git -C "$D" status --porcelain -- "$CONTENT_DIR" >&2
    git -C "$D" add -A -- "$CONTENT_DIR"
    git -C "$D" commit -q -m "wiki: commit note edits found at container start" -- "$CONTENT_DIR"
fi

echo "[entrypoint] updating $BRANCH ..."
git -C "$D" fetch --quiet origin "$BRANCH"
if ! git -C "$D" merge --ff-only "origin/$BRANCH" 2>/dev/null; then
    echo "[entrypoint] diverged — replaying local commits with rebase ..."
    if ! git -C "$D" rebase "origin/$BRANCH"; then
        git -C "$D" rebase --abort || true
        echo "[entrypoint] FATAL: rebase failed; the volume needs a human (git -C $D status)." >&2
        exit 1
    fi
fi

echo "[entrypoint] engine submodule ($ENGINE_PATH) ..."
git -C "$D" submodule sync --quiet
git -C "$D" submodule update --init "$ENGINE_PATH"

# The CMS config is written into the checkout (Vite resolves its imports from
# there); it holds the session settings and the autocommit/autopush switches.
if [ -n "${INKBRUSH_CONFIG_B64:-}" ]; then
    ( umask 077; printf '%s' "$INKBRUSH_CONFIG_B64" | base64 -d > "$D/inkbrush.config.ts" )
    echo "[entrypoint] inkbrush config installed"
else
    echo "[entrypoint] FATAL: INKBRUSH_CONFIG_B64 unset — the defaults leave autocommit and autopush off, so edits would never reach git." >&2
    exit 1
fi

cd "$D"
# astro dev's PID lock survives a container restart inside the volume and
# names a process of the previous container; it is removed, never `--force`d.
rm -f .astro/dev.json
echo "[entrypoint] installing dependencies from the lockfile ..."
if [ -f pnpm-lock.yaml ]; then
    corepack enable >/dev/null 2>&1 || true
    pnpm install --frozen-lockfile
else
    npm ci --no-audit --no-fund
fi
echo "[entrypoint] starting WIKI dev (base=${SITE_BASE:-/}) ..."
exec npx astro dev --host 0.0.0.0 --port 4321
