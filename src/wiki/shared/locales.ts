/**
 * locales — the registry of note languages: the default table, the
 * resolution of a deployment's own table (`content.locales` in
 * inkbrush.config.ts, resolved by server/config.ts), and what a note page
 * offers in its other languages. lib/wikilinks.ts is a standalone,
 * dependency-free library and carries its own fallback table of
 * the code/prefix pairs (labels are UI/prompt-only and live here; the
 * default locale's '' prefix names no mirror, so the resolver's table
 * omits it) — the pairs in the two tables must agree.
 */
import type { NoteLocale, NoteLocaleInfo, NoteMeta } from './types.ts';

export interface LocaleDef {
  code: NoteLocale;
  /** note-id prefix; exactly one locale has '' — that one is the default
   *  (its notes live unprefixed at the content root) */
  prefix: string;
  /** display name for the language-switch UI */
  label: string;
  /** how the language is referred to inside AI prompts */
  promptName: string;
  /** Part title for the appendix section of translated notes */
  appendixTitle: string;
}

/** `content.locales` entry as written in inkbrush.config.ts */
export interface LocaleInput {
  code: string;
  prefix: string;
  label: string;
  promptName: string;
  appendixTitle?: string;
}

export const LOCALES: readonly LocaleDef[] = [
  { code: 'zh', prefix: '', label: '中文', promptName: '中文', appendixTitle: '附录' },
  { code: 'en', prefix: 'en/', label: 'English', promptName: 'English', appendixTitle: 'Appendix' },
  { code: 'de', prefix: 'de/', label: 'Deutsch', promptName: 'Deutsch', appendixTitle: 'Anhang' },
];

/**
 * Resolve the deployment's locale table (pure — no config/server imports, so
 * this file stays safe for either bundle). Absent/empty input keeps the
 * default table. Validation fails loudly: locale mistakes would otherwise
 * surface as silently mis-filed notes.
 */
export function resolveLocales(input?: LocaleInput[] | undefined): readonly LocaleDef[] {
  if (!input || input.length === 0) return LOCALES;
  const seen = new Set<string>();
  const seenPrefixes = new Set<string>();
  const resolved = input.map((l): LocaleDef => {
    if (!l.code || seen.has(l.code)) {
      throw new Error(`content.locales: duplicate or empty code '${l.code}'`);
    }
    seen.add(l.code);
    // a prefix is '' (the default locale) or one id segment of word
    // characters/dashes plus the trailing slash — never nested, never dotted
    if (l.prefix !== '' && !/^[\w-]+\/$/.test(l.prefix)) {
      throw new Error(
        `content.locales: prefix for '${l.code}' must be '' or '<segment>/' where the segment is word characters/dashes (got '${l.prefix}')`,
      );
    }
    if (seenPrefixes.has(l.prefix)) {
      throw new Error(`content.locales: duplicate prefix '${l.prefix}'`);
    }
    seenPrefixes.add(l.prefix);
    return {
      code: l.code,
      prefix: l.prefix,
      label: l.label,
      promptName: l.promptName,
      appendixTitle: l.appendixTitle ?? 'Appendix',
    };
  });
  const defaults = resolved.filter((l) => l.prefix === '');
  if (defaults.length !== 1) {
    throw new Error(
      `content.locales: exactly one locale must have prefix '' (the default locale); got ${defaults.length}`,
    );
  }
  return resolved;
}

/**
 * Whether a page shows the default locale's note. Only that page links its
 * reader to pages in other languages; a translation's reader stays in the
 * translation's language.
 */
export function onDefaultLocale(locales: readonly NoteLocaleInfo[]): boolean {
  return locales.find((l) => l.current)?.prefix === '';
}

/** what a note page offers for one of its other languages */
export interface LanguageAction {
  /** `jump`: open the twin that exists; `translate`: write the missing one */
  kind: 'jump' | 'translate';
  locale: NoteLocaleInfo;
}

/**
 * The page's actions for its other languages, in table order: a jump to
 * each existing twin on the default locale's page, a translation into each
 * missing language unless the note is a copy synced from another wiki
 * (its languages are written at its origin).
 */
export function languageActions(meta: Pick<NoteMeta, 'locales' | 'origin'>): LanguageAction[] {
  const jumps = onDefaultLocale(meta.locales);
  return meta.locales
    .filter((l) => !l.current && (l.exists ? jumps : !meta.origin))
    .map((l) => ({ kind: l.exists ? 'jump' : 'translate', locale: l }));
}
