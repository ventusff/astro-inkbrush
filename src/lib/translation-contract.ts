/**
 * The translation contract: what a rewrite of a note in another language must
 * honour, independent of who runs it. The CMS's own translate job builds its
 * prompt from it (server/prompts.ts), and an external translator — a
 * background sync service, a batch job — builds its prompts from the same
 * parts, so every language version of every site is held to one standard.
 *
 * Pure strings, no imports: it loads in any runtime.
 *
 * Two tiers of writing rules travel with it: hard constraints — what the
 * dialect, the content guard and the MDX compile mechanically refuse — and
 * house style for everything else; a site's own conventions join the
 * house-style tier.
 */

/** what the dialect, the content guard and the MDX compile mechanically
 *  refuse — a note breaking any of these fails validation and the build */
export const HARD_RULES: readonly string[] = [
  'Display math uses the three-line form: `$$` on its own line, the formula, `$$` on its own line (a single-line $$x$$ is refused).',
  'Emphasis markers (`*`, `_`, `~~`) must pair; an unpaired marker that could open emphasis is refused.',
  'Literal braces in prose are escaped: \\{ and \\}; an unescaped `{…}` in MDX prose is a JS expression and is refused.',
  'A line directly under a paragraph must not start with `+` or `*` — a continuation left behind by wrapping turns into a bullet list and is refused.',
  'Every formula must render under strict KaTeX; a broken macro, and any HTML entity inside math (&lt; &gt; &amp;), is refused — write \\lt \\gt \\le \\ge and \\&.',
  'In MDX, a JSX attribute value containing double quotes uses single-quote delimiters; a straight double quote inside a double-quoted attribute breaks the compile.',
];

/** conventions the checks do not mechanically catch; follow them anyway */
export const STYLE_RULES: readonly string[] = [
  'After wrapping a long sentence, a continuation line must not start with `-` or `1.` either (it reads as a list).',
  '`<` followed by a letter or digit in prose is written &lt;; inside $…$ math it stays as it is.',
  'Emphasis is written with ** and *, never with HTML tags.',
  'Component props do not render markdown or math: write Unicode characters (α, Σ) in them instead.',
  'A `|` inside a GFM table cell is written \\lvert … \\rvert inside math and \\| elsewhere.',
];

/** the two rule tiers as prompt text; `siteRules` join the house style */
export function writingRules(siteRules: readonly string[] = []): string {
  const style = [...STYLE_RULES, ...siteRules];
  return [
    `Hard constraints — the build refuses these:\n${HARD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    `House style — follow these:\n${style.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
  ].join('\n');
}

export interface TranslationContract {
  /** how the target text must read */
  principles: string;
  /** what must survive the rewrite unchanged, and what must not survive */
  invariants: string;
  /** the writing rules (hard constraints and house style) */
  rules: string;
  /** the check every run of output must pass before it is handed back;
   *  phrased to follow "re-read <the output> and " */
  selfCheck: string;
}

/**
 * The contract for rewriting a note in `targetLang` — the language's name as
 * a prompt refers to it ("English", "Deutsch", "中文"); `rules` are the
 * site's own conventions.
 */
export function translationContract(opts: { targetLang: string; rules?: readonly string[] | undefined }): TranslationContract {
  const name = opts.targetLang;
  return {
    principles: `Writing principles (most important):
- Restate every paragraph naturally in ${name}: use the terms the ${name}-speaking community actually uses, and reshape sentences to ${name} prose rhythm. The result must read as if it had been written in ${name} from the start — no translationese.
- The article's structure is invariant: heading hierarchy and order, paragraph sequence, and the flow of the argument correspond one-to-one with the original.`,
    invariants: `Invariants (check each one):
- Heading anchor ids and every other identifier are preserved verbatim; only reader-facing text is rewritten.
- Math keeps its structure and LaTeX notation ($…$ and $$…$$) untouched, BUT every piece of natural-language text inside a formula must be ${name} — \\text{…}/\\mathrm{…}/\\operatorname{…}, words in subscripts, \\underbrace/\\overbrace annotations, \\textbf/\\textit. No source-language characters may survive inside any formula.
- Code blocks keep their logic untouched, BUT comments (including end-of-line ones), natural-language words in pseudocode and user-visible string literals are translated into ${name}; where the original had bilingual comments, keep only the ${name} half. No source-language characters may survive inside any code block (except examples that deliberately showcase such data).
- Image paths unchanged; captions translated.
- JSX component tags and their prop structure stay unchanged; reader-facing copy props (title, kicker, caption slots, …) are translated, machine props (id, demo, canvas, …) are not.
- Reference entries: paper titles, authors and venues stay in their original language; descriptive text is translated.
- Every frontmatter copy field (title, description and the like) is rewritten in ${name}; structural fields are preserved verbatim.`,
    rules: writingRules(opts.rules ?? []),
    selfCheck:
      'inspect every run of source-language characters — a run inside math ($…$/$$…$$) or code (fenced blocks, inline `code`) is a violation; translate and re-check until those regions are clean.',
  };
}
