#!/bin/sh
# Container entry for the editing machine: clone or update the site repo in
# the volume, install the machine's CMS config and credentials, install
# dependencies from the lockfile, run the permanent WIKI dev server.
#
# Inputs (service environment). Every *_B64 input also accepts a
# <NAME>_FILE alternative naming a mounted file (docker secrets) whose raw
# content is used as-is; when both are set, the file wins.
#   REPO_URL              the site repository (SSH or HTTPS)             required
#   REPO_BRANCH           branch to track                                 default main
#   CONTENT_DIR           note content tree, relative to the repo root    default src/content
#   ENGINE_PATH           the astro-inkbrush submodule path               default vendor/astro-inkbrush
#   BOT_SSH_KEY_B64       base64 private key for git over SSH             required (or BOT_SSH_KEY_FILE)
#   INKBRUSH_CONFIG_B64   base64 inkbrush.config.ts for this machine      required (or INKBRUSH_CONFIG_FILE)
#   SAML_IDP_CERT_B64     base64 IdP signing certificate (public)         optional (or SAML_IDP_CERT_FILE)
#   KNOWN_HOSTS_B64       base64 known_hosts pinning the git host's key   optional (or KNOWN_HOSTS_FILE)
#                         — installed, SSH runs StrictHostKeyChecking=yes;
#                         absent, accept-new pins the first key seen
#   SITE_BASE             Astro base path                                 default /
#   GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL                              optional
#
# Failure policy: every step that decides whether edits reach git — the key,
# the config, the autocommit contract, the pull, the push of recovered
# commits — fails the container rather than serving a state that silently
# loses work.
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

# install_secret NAME DEST — the secret named NAME arrives as <NAME>_FILE
# (a mounted file, copied verbatim) or <NAME>_B64 (base64 in the
# environment, decoded); the file wins when both are set. Returns 1 when
# neither is set.
install_secret() {
    _file=$(eval "printf '%s' \"\${${1}_FILE:-}\"")
    _b64=$(eval "printf '%s' \"\${${1}_B64:-}\"")
    if [ -n "$_file" ]; then
        cat "$_file" > "$2"
    elif [ -n "$_b64" ]; then
        printf '%s' "$_b64" | base64 -d > "$2"
    else
        return 1
    fi
}

# Credentials and config are written to files that only this user can read.
umask 077
if ! install_secret BOT_SSH_KEY /tmp/bot-key; then
    echo "[entrypoint] FATAL: BOT_SSH_KEY_B64 / BOT_SSH_KEY_FILE unset — no git over SSH." >&2
    exit 1
fi
if install_secret KNOWN_HOSTS /tmp/known_hosts; then
    # a pinned host key turns on MITM detection for every git connection
    export GIT_SSH_COMMAND="ssh -i /tmp/bot-key -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/known_hosts"
    echo "[entrypoint] bot key installed; known_hosts pinned (StrictHostKeyChecking=yes)"
else
    # without a pin, the first host key seen is accepted and pinned
    export GIT_SSH_COMMAND="ssh -i /tmp/bot-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts"
    echo "[entrypoint] bot key installed (no KNOWN_HOSTS pin — accept-new)"
fi
if install_secret SAML_IDP_CERT /tmp/idp-cert.pem; then
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

LOCKFILES=':(glob)**/package-lock.json'
LOCKFILES2=':(glob)**/pnpm-lock.yaml'
# Lockfile drift in the volume is discarded, never committed: the
# container's own install rewrites lockfiles, and a machine that commits
# them fights every push. The container cannot tell its own install's drift
# from a deliberate edit, so the discarded diff is printed first — a real
# lockfile change is visible in the log instead of vanishing.
if ! git -C "$D" diff --quiet HEAD -- "$LOCKFILES" "$LOCKFILES2" 2>/dev/null; then
    echo "[entrypoint] discarding lockfile drift (commit lockfile changes upstream, not on this machine):" >&2
    git -C "$D" diff --stat HEAD -- "$LOCKFILES" "$LOCKFILES2" >&2
    git -C "$D" checkout -q -- "$LOCKFILES" "$LOCKFILES2"
fi

# Uncommitted changes in the volume are CMS saves that did not reach git.
# Recovery spans the whole repo, not only CONTENT_DIR — companion files live
# outside it: every tracked change (except the engine submodule pointer;
# lockfiles already match HEAD) plus new files under CONTENT_DIR. Untracked
# files outside the content tree are not the CMS's and stay untracked.
RECOVERED=0
git -C "$D" add -u -- . ":(exclude)$ENGINE_PATH"
git -C "$D" add -A -- "$CONTENT_DIR"
if [ -n "$(git -C "$D" diff --cached --name-only)" ]; then
    echo "[entrypoint] uncommitted edits in the volume — committing them before the update:" >&2
    git -C "$D" diff --cached --name-status >&2
    git -C "$D" commit -q -m "wiki: commit edits found at container start"
    RECOVERED=1
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

# Push policy: a recovery commit exists only in this volume and autopush
# replays only future saves, so it is pushed now and a failed push stops
# the container (under set -e). With nothing recovered, any older local
# commits are autopush's to deliver — no push, no failure here.
if [ "$RECOVERED" = 1 ]; then
    echo "[entrypoint] pushing recovered commits ..."
    git -C "$D" push origin "HEAD:$BRANCH"
fi

echo "[entrypoint] engine submodule ($ENGINE_PATH) ..."
git -C "$D" submodule sync --quiet
git -C "$D" submodule update --init "$ENGINE_PATH"

# The CMS config is written into the checkout (Vite resolves its imports from
# there); it holds the session settings and the autocommit/autopush switches.
if ( umask 077; install_secret INKBRUSH_CONFIG "$D/inkbrush.config.ts" ); then
    echo "[entrypoint] inkbrush config installed"
else
    echo "[entrypoint] FATAL: INKBRUSH_CONFIG_B64 / INKBRUSH_CONFIG_FILE unset — the defaults leave autocommit and autopush off, so edits would never reach git." >&2
    exit 1
fi

# The machine's contract is that edits reach git: autocommit must be on,
# through the config (`autocommit: true`) or the WIKI_AUTOCOMMIT env
# override (any value but '0'; an explicit WIKI_AUTOCOMMIT=0 overrides the
# config to off, matching the server's env-flag rule).
AUTOCOMMIT_ON=0
case "${WIKI_AUTOCOMMIT:-}" in
    '') if grep -Eq 'autocommit[[:space:]]*:[[:space:]]*true' "$D/inkbrush.config.ts"; then AUTOCOMMIT_ON=1; fi ;;
    0) ;;
    *) AUTOCOMMIT_ON=1 ;;
esac
if [ "$AUTOCOMMIT_ON" != 1 ]; then
    echo "[entrypoint] FATAL: autocommit is off — set 'autocommit: true' in inkbrush.config.ts or WIKI_AUTOCOMMIT=1; without it edits never reach git." >&2
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
