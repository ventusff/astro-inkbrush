/**
 * The preview renders a fragment: a footnote definition nothing in the
 * fragment references shows its content in place; a referenced one keeps
 * the footnote section.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRenderProcessor } from '../src/lib/render-pipeline.ts';

test('an unreferenced footnote definition previews in place, under its label', async () => {
  const p = await buildRenderProcessor({ sanitize: false, site: {}, fragment: true });
  const html = String(await p.process('[^a]: hello **there**\n'));
  assert.match(html, /<code>\[\^a\]<\/code> hello <strong>there<\/strong>/);
  assert.doesNotMatch(html, /data-footnotes/);
});

test('a referenced definition and a whole-note render keep the footnote section', async () => {
  const fragment = await buildRenderProcessor({ sanitize: false, site: {}, fragment: true });
  const html = String(await fragment.process('Text[^a]\n\n[^a]: note\n'));
  assert.match(html, /data-footnotes/);
  assert.doesNotMatch(html, /<code>\[\^a\]<\/code>/);
  const whole = await buildRenderProcessor({ sanitize: false, site: {} });
  assert.equal(String(await whole.process('[^a]: orphan\n')).trim(), '');
});
