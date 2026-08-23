/**
 * CMS pollution markers — the strings whose presence in reader-facing
 * output means the CMS leaked into it. One list, two enforcers:
 * scripts/check-dist.mjs (a static build must be engine-free) and
 * src/wiki/server/snapshot.ts (a public share snapshot must be engine-free).
 * Importable from both a package script and server code; depends on
 * nothing.
 *
 * Only EXECUTABLE evidence counts: the client's API prefix and the block
 * stamps. A paired design layer (astro-inkstone) ships dormant `.wiki-*`
 * chrome skin in every build, site content and data may name the engine,
 * and the `inkbrush-note` meta tags are site-owned identity markup — none
 * of that is pollution, so the style and name markers exist for labeling
 * only and drive no detection.
 */

/** the inkbrush client addresses its server here; nothing else in a site does */
export const CMS_API_MARKER = '/api/wiki/';

/** rehypeWikiBlocks stamps (`data-wiki-src`, `data-wiki-jsx`) — WIKI-mode
 *  markup that must never reach a static build */
export const CMS_STAMP_MARKER = 'data-wiki-';

/** the CMS chrome styles all live under a `.wiki-` class prefix */
/** dormant chrome styling is NOT pollution: a site pairing a design layer
 *  that skins the CMS chrome (astro-inkstone's `.wiki-comments` rules) ships
 *  those selectors in every build by design — only executable markers count */
export const CMS_STYLE_MARKER = '.wiki-';

/** the component name (match case-insensitively); subject to the meta/prose
 *  exemption above */
/** the product's name is NOT pollution either: site content and data may
 *  discuss the engine by name — kept only for labeling, never for detection */
export const CMS_NAME_MARKER = 'inkbrush';

/** every marker, for whole-content sweeps over executable markup */
export const POLLUTION_MARKERS: readonly string[] = [
  CMS_API_MARKER,
  CMS_STAMP_MARKER,
];
