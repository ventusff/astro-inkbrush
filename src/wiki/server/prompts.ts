/**
 * Prompt builders for the three claude job kinds. The prompts are English;
 * the note content may be in any language, so every prompt pins the output
 * language (the note's own for edits and answers, the target locale for
 * translations).
 *
 * Every prompt carries the writing rules in two tiers: hard constraints —
 * only what the dialect, the content guard and the MDX compile mechanically
 * refuse — and house style for everything else. A site's own conventions
 * (component vocabulary, heading attributes, generated numbering, …) from
 * `inkbrush.config.ts → claude.rules` join the house-style tier, and
 * `claude.companions` names the files a job may change beside the note.
 */
import type { LocaleDef } from '../shared/locales.ts';
import type { NoteMeta } from '../shared/types.ts';
import { wikiConfig } from './config.ts';

/** deployment locale table (inkbrush.config.ts → content.locales) */
const locales = (): readonly LocaleDef[] => wikiConfig().content.locales;
const langName = (code: string): string => locales().find((l) => l.code === code)?.promptName ?? code;

/** what the dialect, the content guard and the MDX compile mechanically
 *  refuse — a note breaking any of these fails validation and the build */
const HARD_RULES = [
  'Display math uses the three-line form: `$$` on its own line, the formula, `$$` on its own line (a single-line $$x$$ is refused).',
  'Emphasis markers (`*`, `_`, `~~`) must pair; an unpaired marker that could open emphasis is refused.',
  'Literal braces in prose are escaped: \\{ and \\}; an unescaped `{…}` in MDX prose is a JS expression and is refused.',
  'A line directly under a paragraph must not start with `+` or `*` — a continuation left behind by wrapping turns into a bullet list and is refused.',
  'Every formula must render under strict KaTeX; a broken macro, and any HTML entity inside math (&lt; &gt; &amp;), is refused — write \\lt \\gt \\le \\ge and \\&.',
  'In MDX, a JSX attribute value containing double quotes uses single-quote delimiters; a straight double quote inside a double-quoted attribute breaks the compile.',
];

/** conventions the checks do not mechanically catch; follow them anyway */
const STYLE_RULES = [
  'After wrapping a long sentence, a continuation line must not start with `-` or `1.` either (it reads as a list).',
  '`<` followed by a letter or digit in prose is written &lt;; inside $…$ math it stays as it is.',
  'Emphasis is written with ** and *, never with HTML tags.',
  'Component props do not render markdown or math: write Unicode characters (α, Σ) in them instead.',
  'A `|` inside a GFM table cell is written \\lvert … \\rvert inside math and \\| elsewhere.',
];

function rules(): string {
  const style = [...STYLE_RULES, ...wikiConfig().claude.rules];
  return [
    `Hard constraints — the build refuses these:\n${HARD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    `House style — follow these:\n${style.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
  ].join('\n');
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
  /** project-relative companion paths the job may change */
  companions: string[];
}): string {
  const { meta, targetId, targetLang, companions } = opts;
  const name = langName(targetLang);
  const targetFile = `${wikiConfig().content.dir}/${targetId}/index.${meta.file.endsWith('.md') ? 'md' : 'mdx'}`;
  return `You are the author of the note "${meta.title}". Rewrite the article in ${name} — as its author, not as a translator. You are working in a copy of the relevant files; paths are relative to the current directory.

Source file: ${meta.file}
Target file: ${targetFile} (create it with the Write tool; its directory exists)

Writing principles (most important):
- Restate every paragraph naturally in ${name}: use the terms the ${name}-speaking community actually uses, and reshape sentences to ${name} prose rhythm. The result must read as if it had been written in ${name} from the start — no translationese.
- The article's structure is invariant: heading hierarchy and order, paragraph sequence, and the flow of the argument correspond one-to-one with the original.

Invariants (check each one):
- Heading anchor ids and every other identifier are preserved verbatim; only reader-facing text is rewritten.
- Math keeps its structure and LaTeX notation ($…$ and $$…$$) untouched, BUT every piece of natural-language text inside a formula must be ${name} — \\text{…}/\\mathrm{…}/\\operatorname{…}, words in subscripts, \\underbrace/\\overbrace annotations, \\textbf/\\textit. No source-language characters may survive inside any formula.
- Code blocks keep their logic untouched, BUT comments (including end-of-line ones), natural-language words in pseudocode and user-visible string literals are translated into ${name}; where the original had bilingual comments, keep only the ${name} half. No source-language characters may survive inside any code block (except examples that deliberately showcase such data).
- Image paths unchanged; captions translated.
- JSX component tags and their prop structure stay unchanged; reader-facing copy props (title, kicker, caption slots, …) are translated, machine props (id, demo, canvas, …) are not.
- Reference entries: paper titles, authors and venues stay in their original language; descriptive text is translated.
- Every frontmatter copy field (title, description and the like) is rewritten in ${name}; structural fields are preserved verbatim.${companionNote(companions)}

${rules()}

Process: Read the source file first (long files in several passes — no skipping), then Write the complete target file in one go.

Final self-check (mandatory): re-read the target file and inspect every run of source-language characters — a run inside math ($…$/$$…$$) or code (fenced blocks, inline \`code\`) is a violation; translate and re-check until those regions are clean. Finish with a one- or two-sentence summary (shown on the page).`;
}
