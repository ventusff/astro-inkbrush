import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { HARD_RULES, STYLE_RULES, translationContract, writingRules } from '../src/lib/translation-contract.ts';
import { setConfigInput } from '../src/wiki/server/config.ts';
import { blockEditPrompt, translatePrompt } from '../src/wiki/server/prompts.ts';
import type { NoteMeta } from '../src/wiki/shared/types.ts';

const golden = (name: string): string => readFileSync(new URL(`./fixtures/prompts/${name}`, import.meta.url), 'utf8');

setConfigInput({ content: { dir: 'src/content/notes' }, claude: { rules: ['Site rule one.', 'Site rule two.'] } } as never);
after(() => setConfigInput(null));

const meta = { id: 'ml/vast', file: 'src/content/notes/ml/vast/index.mdx', title: 'VastGaussian', lang: 'zh', locales: [] } as unknown as NoteMeta;
const metaMd = { id: 'a', file: 'src/content/notes/a/index.md', title: 'A', lang: 'en', locales: [] } as unknown as NoteMeta;

test('the CMS prompts are built from the contract, byte for byte', () => {
  assert.equal(translatePrompt({ meta, targetId: 'de/ml/vast', targetLang: 'de' }), golden('translate-de.txt'));
  assert.equal(translatePrompt({ meta: metaMd, targetId: 'a', targetLang: 'zh' }), golden('translate-zh.txt'));
  assert.equal(blockEditPrompt({ meta, start: 3, end: 5, source: '段落', instruction: '改写', companions: ['demo.ts'] }), golden('block-edit.txt'));
});

test('a contract names its target language throughout and carries the site rules in the house style', () => {
  const c = translationContract({ targetLang: 'English', rules: ['Use the house glossary.'] });
  assert.match(c.principles, /^Writing principles \(most important\):\n/);
  assert.match(c.principles, /the terms the English-speaking community actually uses/);
  assert.match(c.invariants, /must be English — /);
  assert.ok(c.rules.startsWith(writingRules(['Use the house glossary.']).split('\n')[0]!));
  assert.match(c.rules, new RegExp(`${STYLE_RULES.length + 1}\\. Use the house glossary\\.$`));
  assert.equal(c.rules.split('\n').filter((l) => /^\d+\. /.test(l)).length, HARD_RULES.length + STYLE_RULES.length + 1);
  assert.match(c.selfCheck, /^inspect every run of source-language characters/);
  assert.equal(translationContract({ targetLang: 'Deutsch' }).rules, writingRules());
});
