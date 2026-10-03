/**
 * An imported inbox note is framed — brand, subtitle, Source line, link
 * label, missing-attachment marker — in the language of the default locale,
 * the one `inbox/<slug>` belongs to.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setConfigInput } from '../src/wiki/server/config.ts';
import { convertObsidianNote } from '../src/wiki/server/obsidian.ts';
import { setProjectRoot } from '../src/wiki/server/store.ts';

const CLIP = `---
source: Example
url: https://example.com/a
saved: 2026-08-23T10:00:00Z
---
Body text with ![[gone.png]] in it.
`;

function framed(locales?: { code: string; prefix: string; label: string; promptName: string }[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inkbrush-inbox-frame-')));
  mkdirSync(join(root, 'src', 'content', 'notes'), { recursive: true });
  const vault = join(root, 'vault');
  const stage = join(root, 'stage');
  mkdirSync(vault);
  mkdirSync(stage);
  writeFileSync(join(vault, 'clip.md'), CLIP);
  const cwd = process.cwd();
  setProjectRoot(root);
  setConfigInput({ content: { dir: 'src/content/notes', ...(locales ? { locales } : {}) } });
  try {
    return convertObsidianNote(join(vault, 'clip.md'), { stageDir: stage }).source;
  } finally {
    setConfigInput(null);
    setProjectRoot(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

test('a Chinese default locale frames the note in Chinese', () => {
  const source = framed();
  assert.match(source, /brand: 收件箱/);
  assert.match(source, /subtitle: Obsidian 同步 · 2026-08-23/);
  assert.match(source, /^> 来源：\[Example\]\(https:\/\/example\.com\/a\) · 2026-08-23$/m);
  assert.match(source, /\*\[缺少附件：gone\.png\]\*/);
});

test('an English or German default locale frames it in that language; another language takes English', () => {
  const en = framed([
    { code: 'en', prefix: '', label: 'English', promptName: 'English' },
    { code: 'zh', prefix: 'zh/', label: '中文', promptName: '中文' },
  ]);
  assert.match(en, /brand: Inbox/);
  assert.match(en, /subtitle: Obsidian sync · 2026-08-23/);
  assert.match(en, /^> Source: \[Example\]/m);
  assert.match(en, /\*\[missing attachment: gone\.png\]\*/);

  const de = framed([{ code: 'de-DE', prefix: '', label: 'Deutsch', promptName: 'Deutsch' }]);
  assert.match(de, /subtitle: Obsidian-Sync · 2026-08-23/);
  assert.match(de, /^> Quelle: \[Example\]/m);
  assert.match(de, /\*\[fehlender Anhang: gone\.png\]\*/);

  const fr = framed([{ code: 'fr', prefix: '', label: 'Français', promptName: 'Français' }]);
  assert.match(fr, /^> Source: \[Example\]/m);
});
