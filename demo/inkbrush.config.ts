/**
 * Demo deployment config. Unlike a real site's inkbrush.config.ts (which is
 * per-machine and gitignored), the demo commits its config so `npm run wiki`
 * works out of the box. Only two things are configured; everything else
 * keeps its default (off).
 */
import { defineInkbrushConfig } from 'astro-inkbrush/config';

export default defineInkbrushConfig({
  auth: {
    // Local quick sign-in (name + email, no password) — exactly right for a
    // demo on your own machine. Anything externally reachable must turn this
    // off and use Google OAuth / SAML instead (see inkbrush.config.example.ts).
    dev: true,
  },
  content: {
    // Note ids map to src/content/notes/<id>/index.md (the default dir).
    // This demo is English-first: unprefixed notes are English, and Chinese
    // mirrors live under zh/ — which is also what the ✦ translation feature
    // targets.
    locales: [
      { code: 'en', prefix: '', label: 'English', promptName: 'English' },
      { code: 'zh', prefix: 'zh/', label: '中文', promptName: 'Chinese (Simplified)', appendixTitle: '附录' },
    ],
  },
});
