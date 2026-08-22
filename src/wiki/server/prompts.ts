/**
 * Prompt builders for the three claude-cli job kinds. The prompts themselves
 * are English; the note content may be in any language, so every prompt pins
 * the output language explicitly (the note's own language for edits and
 * answers, the target locale for translations). Every rule in the MDX digest
 * has actually broken a build before.
 */
import type { LocaleDef } from '../shared/locales';
import type { NoteMeta } from '../shared/types';
import { wikiConfig } from './config';

/** note content directory (inkbrush.config.ts → content.dir) — previously
 *  hardcoded in several places, which broke deployments that move the dir */
const contentDir = (): string => wikiConfig().content.dir;

/** deployment locale table (inkbrush.config.ts → content.locales) */
const locales = (): readonly LocaleDef[] => wikiConfig().content.locales;
const langName = (code: string): string =>
  locales().find((l) => l.code === code)?.promptName ?? code;
const appendixTitle = (code: string): string =>
  locales().find((l) => l.code === code)?.appendixTitle ?? 'Appendix';

const MDX_RULES = `Hard MDX constraints (each one has actually broken a build — follow all of them):
1. Display math must use the three-line form: \`$$\` on its own line + the formula + \`$$\` on its own line (a single-line $$x$$ silently becomes inline math).
2. JSX elements with bare text go on one line (<span>text</span>); block-level markdown inside a component slot needs blank lines around it.
3. After wrapping a long sentence, never leave +, -, *, or 1. at the start of the continuation line (it becomes a list marker and eats the text).
4. \`<\` followed by a digit/letter (e.g. <50%) must be written &lt;, but < inside $…$ math stays as-is.
5. Bold/italic use ** and *; never <strong>.
6. JSX attribute values containing double quotes use single-quote delimiters; never turn straight quotes into curly quotes.
7. Heading attribute blocks use the inline-code form: ## Heading \`{#anchor toc="short label"}\`; anchor ids are always preserved unchanged.
8. Literal { } in prose must be escaped \\{ \\}.
9. Component props such as title do not render markdown/math — use Unicode characters (α, Σ) instead.
10. Math pipes inside GFM table cells are written \\lvert…\\rvert.
11. Heading numbers and §k.n references are generated at build time — never write them by hand; in-text references are [§](#anchor) or [§§](#anchor).`;

export function blockEditPrompt(opts: {
  meta: NoteMeta;
  start: number;
  end: number;
  source: string;
  instruction: string;
}): string {
  const { meta, start, end, source, instruction } = opts;
  const demoFiles = meta.demos.map((d) => `${contentDir()}/${d}.ts`);
  const demoNote =
    demoFiles.length > 0
      ? `\nInteractive demo modules referenced by this page: ${demoFiles.join(', ')}. If this block is a demo mount component and the user's request concerns demo behaviour/drawing/controls, you may also edit the corresponding demo TS files (strict TypeScript; keep the module's existing export contract and cleanup semantics).`
      : '';
  return `You maintain a knowledge base built on Astro + MDX. The user selected one content block on a page and asked you to revise it.

Target file: ${meta.file}
Target block: lines ${start}–${end}, current content between the fences:
\`\`\`mdx
${source}
\`\`\`

The user's request:
${instruction}

Requirements:
- Use the Read tool to confirm the context, then apply the change with Edit; touch only this block, nothing else in the file (unless the request explicitly concerns this page's demos).${demoNote}
- Preserve the note's voice, terminology and language (current language: ${langName(meta.lang)}).
- ${MDX_RULES.split('\n').join('\n- ').replace(/^- /, '')}
- When done, summarize what you changed in one or two sentences (shown on the page).`;
}

export function askPrompt(opts: { meta: NoteMeta; message: string }): string {
  const { meta, message } = opts;
  return `You are the in-site assistant of this knowledge base. A reader is viewing the note "${meta.title}" (source file: ${meta.file}) and has a question about it.

Read the source file first (in chunks if long). If needed, use Grep/Glob/Read on ${contentDir()}/ to inspect the demo modules this page references (${meta.demos.map((d) => `${contentDir()}/${d}.ts`).join(', ') || 'none'}) or other notes on the site, then answer.

Answer requirements:
- Answer in ${langName(meta.lang)} (unless the reader asked in a different language).
- Written for a sidebar next to the page: lead with the conclusion and the reasoning; markdown (including $…$ math) is fine; don't recap the whole article.
- When quoting the note, name the section heading you're quoting from.

The reader's question:
${message}`;
}

export function translatePrompt(opts: { meta: NoteMeta; targetId: string; targetLang: string }): string {
  const { meta, targetId, targetLang } = opts;
  const name = langName(targetLang);
  const targetFile = `${contentDir()}/${targetId}/index.${meta.file.endsWith('.md') ? 'md' : 'mdx'}`;
  const demoFiles = meta.demos.map((d) => `${contentDir()}/${d}.ts`).join(', ') || '(this page has no demos)';
  return `You are the author of the note "${meta.title}". Rewrite the article in ${name} — as its author, not as a translator.

Source file: ${meta.file}
Target file: ${targetFile} (create it with the Write tool; missing directories are created automatically)

Writing principles (most important):
- Restate every paragraph naturally in ${name}: use the terms the ${name}-speaking community actually uses, and reshape sentences to ${name} prose rhythm. The result must read as if it had been written in ${name} from the start — no translationese.
- The article's structure is invariant: heading hierarchy and order, paragraph sequence, and the flow of the argument all correspond one-to-one with the original.

Invariants (check each one):
- Every heading anchor id (the #anchor part inside \`{#anchor …}\`) is preserved verbatim; the toc="…" short labels inside those attribute blocks are translated into ${name}.
- Math keeps its structure and LaTeX notation ($…$ and $$…$$) untouched, BUT every piece of natural-language text inside a formula must be ${name} — not just \\text{…}/\\mathrm{…}/\\operatorname{…}, but also words in subscripts, \\underbrace/\\overbrace annotations, and any text command such as \\textbf/\\textit. No source-language characters may survive inside any formula.
- Code blocks keep their logic untouched, BUT comments (including end-of-line ones), natural-language words in pseudocode, and user-visible string literals are translated into ${name}; where the original had bilingual comments, keep only the ${name} half. No source-language characters may survive inside any code block (except examples that deliberately showcase such data).
- Image paths unchanged; captions translated.
- All JSX component tags and their prop structure stay unchanged; reader-facing copy props (title, kicker, meta, tocLabel, caption slots, …) are translated, machine props (id, demo, canvas, stages, …) are not. (The component vocabulary is the site's MDX library — commonly the astro-inkstone set: Hero, Part, Callout, Grid, PaperCard, References, demo mounts, ….)
- Control ids inside demo-mount control slots are preserved; their visible labels are translated.
- Reference entries: paper titles, authors and venues stay in their original language; descriptive text is translated.
- Every frontmatter copy field (title/brand/subtitle/description/kicker/navLabel/footer) is rewritten in ${name}; structural fields (part/chapters/nav/tocDepth, …) are preserved verbatim. The appendix Part is written <Part appendix title="${appendixTitle(targetLang)}" />.

Demo runtime strings (important, easy to miss): if this page's demo modules (${demoFiles}) display runtime text through a shared per-locale string table (one file serving all languages, keyed by locale code), complete the '${targetLang}' entries of every table (translating from the source-language entries; never change existing keys, never fork the file per language). If a referenced demo module still hardcodes user-facing strings instead, extract them into the module's locale-table pattern first, then add the '${targetLang}' entries. Interpolated values stay in the templates.

${MDX_RULES}

Process: Read the source file first (long files in several passes — no skipping), then Write the complete target file in one go; then update the referenced demo modules per "Demo runtime strings" above.

Final self-check (mandatory): Grep the target file for any characters of the source language (for a CJK source, the regex \`[一-鿿]\`) and inspect every hit — a hit inside math ($…$/$$…$$) or code (fenced blocks, inline \`code\`) is a violation; translate and re-scan until those regions are clean. Finish with a one- or two-sentence summary (shown on the page).`;
}
