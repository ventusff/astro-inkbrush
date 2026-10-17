/**
 * translation-declaration — what a content repository says about its
 * translation: the `i18n.config.json` the translation sync service reads, and
 * the `i18n.lock` beside it.
 *
 * The declaration names the languages (the first is the default language) and
 * the page units: where each unit's files live and how a file's language
 * shows in its path. This module reads the part a check needs and answers two
 * questions the way the service does: which page (unit, id, language) a file
 * is, and which language a page is written in first — its source, whose code
 * the service copies into the other languages.
 *
 * Page layouts:
 *   - `prefix`: the default language at the unit's root, every other language
 *     under a directory named for it (`<root>/en/<file>`);
 *   - `suffix`: the language in the file name (`{id}/index.{locale}.md`); the
 *     default language's file leaves it out, with the `.`, `-` or `_` next to
 *     it, unless `bareDefault` is false.
 * A file template holds `{id}` (the page id, which may hold `/`), `{locale}`
 * and `{a,b}` (one of several spellings, such as extensions); `exclude` takes
 * globs under the unit's root, matched with dotfiles, and an excluded path is
 * no page in any language.
 *
 * A page's source is the language the lock records for its unit
 * (`"pages:<root>:<id>": { "source": "en", … }`). A unit the lock does not
 * record yet takes the declaration's source language when the page exists in
 * it, else the first language of the declaration the page exists in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import picomatch from 'picomatch';

type Piece = { kind: 'text'; text: string } | { kind: 'id' } | { kind: 'locale' } | { kind: 'choice'; options: string[] };

export interface PageUnit {
  /** absolute directory holding the unit's files */
  root: string;
  /** the root as the lock spells it in a unit key (`pages:<root>:<id>`) */
  key: string;
  layout: 'prefix' | 'suffix';
  bareDefault: boolean;
  /** the file template, parsed */
  file: Piece[];
  /** a path under the root that is no page */
  excluded: (rel: string) => boolean;
}

export interface TranslationDeclaration {
  /** absolute path of the i18n.config.json */
  path: string;
  locales: string[];
  /** the declaration's source language: `source`, else zh when listed, else the first language */
  source: string;
  pages: PageUnit[];
  /** the source language the lock records, by unit key */
  recorded: Map<string, string>;
}

/** a page: its unit, id and language, and the spellings its file chose for each `{a,b}` */
export interface Page {
  unit: PageUnit;
  id: string;
  locale: string;
  choices: string[];
}

/**
 * The i18n.config.json in `dir` or a directory above it, up to the
 * repository top (the nearest directory holding `.git`; a checkout without
 * one is searched up to the filesystem root); null when there is none.
 */
export function findTranslationDeclaration(dir: string): string | null {
  for (let at = resolve(dir); ; at = resolve(at, '..')) {
    const path = join(at, 'i18n.config.json');
    if (existsSync(path)) return path;
    if (existsSync(join(at, '.git')) || resolve(at, '..') === at) return null;
  }
}

/** a file template's pieces; a template the service would refuse (an unclosed or unknown `{…}`) is null */
function parseTemplate(template: string): Piece[] | null {
  const pieces: Piece[] = [];
  let text = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c !== '{') {
      text += c;
      continue;
    }
    const close = template.indexOf('}', i);
    if (close < 0) return null;
    const inner = template.slice(i + 1, close);
    if (text) pieces.push({ kind: 'text', text });
    text = '';
    if (inner === 'id') pieces.push({ kind: 'id' });
    else if (inner === 'locale') pieces.push({ kind: 'locale' });
    else if (inner.includes(',')) pieces.push({ kind: 'choice', options: inner.split(',') });
    else return null;
    i = close;
  }
  if (text) pieces.push({ kind: 'text', text });
  return pieces;
}

/** the default language's spelling of a suffix template: `{locale}` goes with the `.`, `-` or `_` before it, else after it */
function withoutLocale(pieces: readonly Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p })) as Piece[];
  const at = out.findIndex((p) => p.kind === 'locale');
  if (at < 0) return out;
  const before = out[at - 1];
  const after = out[at + 1];
  if (before?.kind === 'text' && /[._-]$/.test(before.text)) before.text = before.text.slice(0, -1);
  else if (after?.kind === 'text' && /^[._-]/.test(after.text)) after.text = after.text.slice(1);
  out.splice(at, 1);
  return out.filter((p) => p.kind !== 'text' || p.text !== '');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function formatTemplate(pieces: readonly Piece[], id: string, locale: string, choices: readonly string[]): string {
  let out = '';
  let k = 0;
  for (const p of pieces) {
    if (p.kind === 'text') out += p.text;
    else if (p.kind === 'id') out += id;
    else if (p.kind === 'locale') out += locale;
    else {
      const chosen = choices[k++];
      out += chosen !== undefined && p.options.includes(chosen) ? chosen : p.options[0]!;
    }
  }
  return out;
}

/** `rel` as a file of `locale` under the template: its id and choices, or null */
function matchTemplate(pieces: readonly Piece[], rel: string, locale: string): { id: string; choices: string[] } | null {
  let re = '^';
  let k = 0;
  for (const p of pieces) {
    if (p.kind === 'text') re += escapeRe(p.text);
    else if (p.kind === 'id') re += '(?<id>.+?)';
    else if (p.kind === 'locale') re += escapeRe(locale);
    else re += `(?<c${k++}>${p.options.map(escapeRe).join('|')})`;
  }
  const m = new RegExp(`${re}$`).exec(rel);
  if (!m) return null;
  const groups = m.groups ?? {};
  const choices = Array.from({ length: k }, (_, i) => groups[`c${i}`]!);
  // a template without {id} describes one page: the default language's file name without its extension
  const id = pieces.some((p) => p.kind === 'id') ? groups['id']! : formatTemplate(withoutLocale(pieces), '', '', []).replace(/\.[^./]+$/, '');
  return { id, choices };
}

interface RawUnit {
  kind?: unknown;
  root?: unknown;
  file?: unknown;
  layout?: unknown;
  bareDefault?: unknown;
  exclude?: unknown;
}

/** Read the declaration at `path` and the lock beside it; a declaration that is not JSON throws. */
export function readTranslationDeclaration(path: string): TranslationDeclaration {
  const raw = (JSON.parse(readFileSync(path, 'utf8')) ?? {}) as { locales?: unknown; source?: unknown; units?: unknown };
  const locales = Array.isArray(raw.locales) ? raw.locales.filter((l): l is string => typeof l === 'string') : [];
  const source =
    typeof raw.source === 'string' && locales.includes(raw.source) ? raw.source : locales.includes('zh') ? 'zh' : (locales[0] ?? '');
  const units = Array.isArray(raw.units) ? (raw.units as (RawUnit | null)[]) : [];
  const pages: PageUnit[] = [];
  for (const u of units) {
    if (u?.kind !== 'pages' || typeof u.root !== 'string' || typeof u.file !== 'string') continue;
    const file = parseTemplate(u.file);
    if (file === null) continue;
    const given = u.root.replace(/^\/+|\/+$/g, '');
    const root = given === '.' ? '' : given;
    const exclude = Array.isArray(u.exclude) ? u.exclude.filter((e): e is string => typeof e === 'string') : [];
    const match = exclude.length > 0 ? picomatch(exclude, { dot: true }) : null;
    pages.push({
      root: resolve(dirname(path), root),
      key: root || '.',
      layout: u.layout === 'suffix' ? 'suffix' : 'prefix',
      bareDefault: u.bareDefault !== false,
      file,
      excluded: (rel) => match !== null && match(rel),
    });
  }
  const recorded = new Map<string, string>();
  const lock = join(dirname(path), 'i18n.lock');
  if (existsSync(lock)) {
    try {
      const entries = (JSON.parse(readFileSync(lock, 'utf8')) as { units?: Record<string, { source?: unknown } | null> } | null)?.units ?? {};
      for (const [key, entry] of Object.entries(entries)) if (typeof entry?.source === 'string') recorded.set(key, entry.source);
    } catch {
      // a lock that does not read records nothing; the service reports it
    }
  }
  return { path, locales, source, pages, recorded };
}

/** The page the file at absolute `path` is, or null when it is no page of the declaration. */
export function pageOf(declaration: TranslationDeclaration, path: string): Page | null {
  const [fallback, ...others] = declaration.locales;
  if (fallback === undefined) return null;
  for (const unit of declaration.pages) {
    const inside = relative(unit.root, resolve(path));
    if (inside === '' || inside.startsWith('..') || resolve(unit.root, inside) !== resolve(path)) continue;
    const rel = inside.split(sep).join('/');
    if (unit.excluded(rel)) continue;
    if (unit.layout === 'prefix') {
      const lead = others.find((l) => rel.startsWith(`${l}/`));
      if (lead !== undefined) {
        const file = rel.slice(lead.length + 1);
        if (unit.excluded(file)) continue;
        const m = matchTemplate(unit.file, file, lead);
        if (m) return { unit, ...m, locale: lead };
        continue;
      }
      const m = matchTemplate(unit.file, rel, fallback);
      if (m) return { unit, ...m, locale: fallback };
      continue;
    }
    for (const l of others) {
      const m = matchTemplate(unit.file, rel, l);
      if (m) return { unit, ...m, locale: l };
    }
    const m = matchTemplate(unit.bareDefault ? withoutLocale(unit.file) : unit.file, rel, fallback);
    if (m) return { unit, ...m, locale: fallback };
  }
  return null;
}

/** where `page` sits in `locale`, the same spellings chosen */
function pagePath(declaration: TranslationDeclaration, page: Page, locale: string): string {
  const isDefault = locale === declaration.locales[0];
  if (page.unit.layout === 'prefix') return join(page.unit.root, isDefault ? '' : locale, formatTemplate(page.unit.file, page.id, locale, page.choices));
  const pieces = isDefault && page.unit.bareDefault ? withoutLocale(page.unit.file) : page.unit.file;
  return join(page.unit.root, formatTemplate(pieces, page.id, locale, page.choices));
}

/** The language `page` is written in first (see the module comment). */
export function sourceOfPage(declaration: TranslationDeclaration, page: Page): string {
  const recorded = declaration.recorded.get(`pages:${page.unit.key}:${page.id}`);
  if (recorded !== undefined) return recorded;
  const present = declaration.locales.filter((l) => l === page.locale || existsSync(pagePath(declaration, page, l)));
  return present.includes(declaration.source) ? declaration.source : (present[0] ?? declaration.source);
}

/** The file at absolute `path` is a page in its own source language. */
export function isSourcePage(declaration: TranslationDeclaration, path: string): boolean {
  const page = pageOf(declaration, path);
  return page !== null && sourceOfPage(declaration, page) === page.locale;
}
