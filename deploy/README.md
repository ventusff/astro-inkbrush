# Deployment skeleton: static site + editing machine

One content repository, two services — reading and editing kept apart. Copy
this directory into your site repository (the Dockerfiles take the site root
as their build context) and fill in the `compose.example.yml` values.

```
static/   The reader entry: astro build → nginx. Stateless; every push
          rebuilds it. Build context = the site repository root.
wiki/     The editing entry: a permanent `WIKI=1 astro dev` running the CMS.
          The repository checkout lives in a named volume; the entrypoint
          clones or updates it, installs the machine's config and
          credentials, installs dependencies from the lockfile, and starts
          the server.
```

Contract of the editing machine:

- **Its own subdomain, never a path prefix under the reader host.** The CMS
  mounts its API at the server root and a dev server's module URLs are
  root-relative.
- **Configuration arrives as environment or mounted secrets.**

  | Input | Alternative | Role |
  | --- | --- | --- |
  | `INKBRUSH_CONFIG_B64` | `INKBRUSH_CONFIG_FILE` | the machine's `inkbrush.config.ts` (required) |
  | `BOT_SSH_KEY_B64` | `BOT_SSH_KEY_FILE` | private key for git over SSH (required) |
  | `SAML_IDP_CERT_B64` | `SAML_IDP_CERT_FILE` | IdP signing certificate (optional) |
  | `KNOWN_HOSTS_B64` | `KNOWN_HOSTS_FILE` | known_hosts pinning the git host's key (optional) |

  `*_B64` values are base64 in the service environment; each accepts a
  `<NAME>_FILE` alternative naming a mounted file (docker secrets) with the
  raw content. The entrypoint writes them to disk readable by the service
  user only. A missing config or key fails the container — as does a config
  that leaves `autocommit` off without `WIKI_AUTOCOMMIT=1`: the machine's
  contract is that edits reach git. With `KNOWN_HOSTS` installed, SSH runs
  `StrictHostKeyChecking=yes`; without it, `accept-new` pins the first host
  key seen.
- **Fail closed on synchronisation.** Edits found uncommitted in the volume
  are committed before the update — tracked changes across the whole repo
  plus new files under the content tree, since companion files live outside
  it — and pushed after a successful update (a failed push of recovered
  commits stops the container). A fast-forward is tried first, then a
  rebase of local commits; a rebase that does not apply stops the container
  instead of serving a diverged checkout. Lockfile drift is discarded with
  its diff printed, never committed.
- **Reproducible installs.** `npm ci` or `pnpm install --frozen-lockfile`,
  by the lockfile present.
- **Health.** nginx listens on IPv6 as well (alpine's wget resolves
  `localhost` to `::1`); the probe is `/healthz`.
- **Two webhooks, filtered by committer.** The static site rebuilds on every
  push; the editing machine restarts only on pushes from outside (its own
  autopush commits must not restart it).
