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
- **Configuration arrives as environment.** `INKBRUSH_CONFIG_B64` (the
  machine's `inkbrush.config.ts`), `BOT_SSH_KEY_B64` (git over SSH) and
  optionally `SAML_IDP_CERT_B64` are base64 values the entrypoint writes to
  disk, readable by the service user only. A missing config or key fails the
  container: the defaults leave `autocommit` and `autopush` off, and a server
  that saves without committing loses edits at the next restart.
- **Fail closed on synchronisation.** Edits found uncommitted in the volume
  are committed before the update; a fast-forward is tried first, then a
  rebase of local commits; a rebase that does not apply stops the container
  instead of serving a diverged checkout.
- **Reproducible installs.** `npm ci` or `pnpm install --frozen-lockfile`,
  by the lockfile present.
- **Health.** nginx listens on IPv6 as well (alpine's wget resolves
  `localhost` to `::1`); the probe is `/healthz`.
- **Two webhooks, filtered by committer.** The static site rebuilds on every
  push; the editing machine restarts only on pushes from outside (its own
  autopush commits must not restart it).
