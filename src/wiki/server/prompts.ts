/**
 * Prompt builders for the three claude job kinds. The prompts are English;
 * the note content may be in any language, so every prompt pins the output
 * language (the note's own for edits and answers, the target locale for
 * translations).
 *
 * Every prompt carries the writing rules in two tiers (lib/translation-
 * contract.ts): hard constraints — only what the dialect, the content guard
 * and the MDX compile mechanically refuse — and house style for everything
 * else. A site's own conventions (component vocabulary, heading attributes,
 * generated numbering, …) from `inkbrush.config.ts → claude.rules` join the
 * house-style tier; the translate job's principles, invariants and
 * self-check are the shared translation contract. `claude.companions` names
 * the files a block-edit job may change beside the note (a translation
 * writes the target file and nothing else — companions stay read-only
 * context).
 */
import { translationContract, writingRules } from '../../lib/translation-contract.ts';
import type { LocaleDef } from '../shared/locales.ts';
import type { NoteMeta } from '../shared/types.ts';
import { wikiConfig } from './config.ts';

/** deployment locale table (inkbrush.config.ts → content.locales) */
const locales = (): readonly LocaleDef[] => wikiConfig().content.locales;
const langName = (code: string): string => locales().find((l) => l.code === code)?.promptName ?? code;

function rules(): string {
  return writingRules(wikiConfig().claude.rules);
}

function companionNote(companions: string[]): string {
  if (companions.length === 0) return '';
  return `\nFiles beside the note that you may also read and change when the request concerns them: ${companions.join(', ')}. Keep each file's existing export contract.`;
}

export function blockEditPrompt(opts: {
  meta: NoteMeta;
  start: number;
  end: number;
  source: string;
  instruction: string;
  /** project-relative companion paths the job may change */
  companions: string[];
}): string {
  const { meta, start, end, source, instruction, companions } = opts;
  return `You maintain a knowledge base built on Astro + Markdown/MDX. The user selected one content block on a page and asked you to revise it. You are working in a copy of the relevant files; paths are relative to the current directory.

Target file: ${meta.file}
Target block: lines ${start}–${end}, current content between the fences:
\`\`\`mdx
${source}
\`\`\`

The user's request:
${instruction}

Requirements:
- Read the file to confirm the context, then apply the change with Edit; touch only this block, nothing else in the file.${companionNote(companions)}
- Preserve the note's voice, terminology and language (current language: ${langName(meta.lang)}).
- ${rules().split('\n').join('\n  ')}
- When done, summarize what you changed in one or two sentences (shown on the page).`;
}

export function askPrompt(opts: { meta: NoteMeta; message: string }): string {
  const { meta, message } = opts;
  return `You are the in-site assistant of this knowledge base. A reader is viewing the note "${meta.title}" (source file: ${meta.file}, relative to the current directory) and has a question about it.

Read the source file first (in chunks if long); the files beside it are the note's own assets. Then answer.

Answer requirements:
- Answer in ${langName(meta.lang)} (unless the reader asked in a different language).
- Written for a sidebar next to the page: lead with the conclusion and the reasoning; markdown (including $…$ math) is fine; do not recap the whole article.
- When quoting the note, name the section heading you are quoting from.

The reader's question:
${message}`;
}

export function translatePrompt(opts: {
  meta: NoteMeta;
  targetId: string;
  targetLang: string;
}): string {
  const { meta, targetId, targetLang } = opts;
  const name = langName(targetLang);
  const targetFile = `${wikiConfig().content.dir}/${targetId}/index.${meta.file.endsWith('.md') ? 'md' : 'mdx'}`;
  const contract = translationContract({ targetLang: name, rules: wikiConfig().claude.rules });
  return `You are the author of the note "${meta.title}". Rewrite the article in ${name} — as its author, not as a translator. You are working in a copy of the relevant files; paths are relative to the current directory.

Source file: ${meta.file}
Target file: ${targetFile} (create it with the Write tool; its directory exists)

${contract.principles}

${contract.invariants}
- You write exactly one file: the target. Files beside the note are read-only context; a change to any other file is refused as a whole.

${contract.rules}

Process: Read the source file first (long files in several passes — no skipping), then Write the complete target file in one go.

Final self-check (mandatory): re-read the target file and ${contract.selfCheck} Finish with a one- or two-sentence summary (shown on the page).`;
}
