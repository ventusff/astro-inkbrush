/**
 * locales — the single registry of note languages.
 *
 * Historically source.ts / prompts.ts / lib/wikilinks.ts each kept their own
 * copy; adding a language meant touching three files and it was easy to miss
 * one. Now: the DEFAULT table lives here, and a deployment can replace it via
 * `content.locales` in inkbrush.config.ts (resolved by server/config.ts).
 *
 * Note: lib/wikilinks.ts is a zero-dependency standalone library (composition
 * belongs to the caller), so its DEFAULT_LOCALES is only an uninjected
 * fallback — keep it in sync when the default table changes.
 */
import type { NoteLocale } from './types';

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
  { code: 'de', prefix: 'de/', label: 'Deutsch', promptName: 'Deutsch（德语）', appendixTitle: 'Anhang' },
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
  const resolved = input.map((l): LocaleDef => {
    if (!l.code || seen.has(l.code)) {
      throw new Error(`content.locales: duplicate or empty code '${l.code}'`);
    }
    seen.add(l.code);
    if (l.prefix !== '' && !l.prefix.endsWith('/')) {
      throw new Error(`content.locales: prefix for '${l.code}' must be '' or end with '/' (got '${l.prefix}')`);
    }
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

export const localeDef = (code: NoteLocale): LocaleDef => LOCALES.find((l) => l.code === code)!;
