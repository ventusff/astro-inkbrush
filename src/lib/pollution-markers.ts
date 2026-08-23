/**
 * CMS pollution markers — the strings whose presence in reader-facing
 * output means the CMS leaked into it. One list, two enforcers:
 * scripts/check-dist.mjs (a static build must be engine-free) and
 * src/wiki/server/snapshot.ts (a public share snapshot must be engine-free).
 * Importable from both a package script and server code; depends on
 * nothing.
 *
 * Exemption, honored by every consumer: the `inkbrush-note` /
 * `inkbrush-note-url` meta tags are site-owned identity markup present in
 * every build by contract, and page prose may discuss the CMS — so the
 * component-name marker applies to executable and style content (scripts,
 * stylesheets, textual assets), never to page markup or prose.
 */

/** the inkbrush client addresses its server here; nothing else in a site does */
export const CMS_API_MARKER = '/api/wiki/';

/** rehypeWikiBlocks stamps (`data-wiki-src`, `data-wiki-jsx`) — WIKI-mode
 *  markup that must never reach a static build */
export const CMS_STAMP_MARKER = 'data-wiki-';

/** the CMS chrome styles all live under a `.wiki-` class prefix */
export const CMS_STYLE_MARKER = '.wiki-';

/** the component name (match case-insensitively); subject to the meta/prose
 *  exemption above */
export const CMS_NAME_MARKER = 'inkbrush';

/** every marker, for whole-content sweeps over executable markup */
export const POLLUTION_MARKERS: readonly string[] = [
  CMS_API_MARKER,
  CMS_STAMP_MARKER,
  CMS_STYLE_MARKER,
  CMS_NAME_MARKER,
];
