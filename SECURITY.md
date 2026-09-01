# Security policy

## Supported versions

The latest 0.x release of astro-inkbrush on `main`. Older tags receive no fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private vulnerability reporting for this repository — **Security → Report a
vulnerability** — which is enabled here and reaches the maintainer directly.
Include the affected version, a minimal reproduction and the impact you see.
You will get an acknowledgement within seven days, and a fix or a clear
statement before anything is disclosed.

## Scope

astro-inkbrush is a dev-server CMS for Astro: authentication (Google OAuth,
SAML, a dev provider), a block save gate, revision history, comments, an
Obsidian inbox importer, share snapshots and an AI assist that runs the
`claude` CLI in a sandbox. It runs on editing machines only — a static build
carries none of it (`check-dist` holds that line). Reports that matter most:
anything that lets a request bypass authentication or CSRF checks, write
outside the content root, escape the AI sandbox, or leak CMS state into a
published build or share snapshot.
