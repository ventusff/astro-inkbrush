#!/usr/bin/env node
/**
 * check-language — a page's code is the same in every language.
 *
 * In a repository whose pages the translation sync service translates (an
 * `i18n.config.json` over the content root), the service translates a page's
 * prose and copies its code — the script, attributes of components and raw
 * HTML other than the reader-facing ones, inline code, code blocks outside
 * their comments — from a page's source language into every other language as
 * written. This CLI reads every page under <root> that is in its own source
 * language (the language i18n.lock records for it, see
 * src/lib/translation-declaration.ts) and lists each place where Chinese sits
 * in that code (src/lib/code-language.ts): the other languages' copies follow
 * these pages, so they are not read.
 *
 * Every finding is a warning, listed and passing, unless the site's
 * `--config` module raises its place to an error with a `codeLanguage`
 * export (codeLanguageSeverity in src/lib/code-language.ts); errors fail the
 * run. check-content runs the same check among its
 * own; this CLI runs it alone, in a second or two, and lists the warnings
 * first-hand.
 *
 * Usage (from the site's directory):
 *   node vendor/astro-inkbrush/scripts/check-language.mjs src/content/docs --config src/lib/page-pipeline.mjs
 *
 *   <root>             directory to scan (default .)
 *   --glob <pattern>   files to check, relative to <root> (repeatable; default
 *                      **\/index.{md,mdx})
 *   --skip <dir>       a directory, relative to <root>, not to scan
 *   --config <path>    the site's plugin module, as for check-content: its
 *                      remark plugins' syntax (math, directives) is how the
 *                      page is read
 *   --math             read `$…$` as math without --config
 *
 * Exit code: 0 no errors (warnings included), 1 errors, 2 usage error.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { codeLanguageAdvice, codeLanguageLine, contentFiles, loadSiteConfig } from './check-content.mjs';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const { markdownSyntax } = await import(pathToFileURL(join(engineRoot, 'src/lib/markdown-syntax.ts')).href);
const { splitFrontmatter } = await import(pathToFileURL(join(engineRoot, 'src/lib/frontmatter.ts')).href);
const { codeLanguageFindings } = await import(pathToFileURL(join(engineRoot, 'src/lib/code-language.ts')).href);
const { findTranslationDeclaration, isSourcePage, readTranslationDeclaration } = await import(
  pathToFileURL(join(engineRoot, 'src/lib/translation-declaration.ts')).href
);

/** a parser for md or mdx pages: the dialect, the site's syntax, MDX for .mdx */
function parser({ mdx, math, site }) {
  return unified()
    .use(remarkParse)
    .use(mdx ? [remarkMdx] : [])
    .use(markdownSyntax())
    .use(math ? [remarkMath] : [])
    .use(site?.remarkPlugins ?? [])
    .freeze();
}

/**
 * The code-language findings of every page under `root` in its own source
 * language: `{ declaration, checked, files: [{ file, errors, warnings }], places }`,
 * `declaration` null when no translation is declared over the root, `places`
 * the kinds of place reported. `site` is a loaded --config module
 * (check-content's loadSiteConfig): its remark plugins' syntax and its
 * code-language severity.
 * @param {string} root
 * @param {{ globs?: string[], skip?: string[], math?: boolean,
 *           site?: { remarkPlugins: unknown[], codeLanguage?: Record<string, 'error' | 'warning'> } }} [options]
 */
export async function checkLanguage(root, { globs = ['**/index.{md,mdx}'], skip = [], math = false, site } = {}) {
  const absRoot = resolve(root);
  const path = findTranslationDeclaration(absRoot);
  if (path === null) return { declaration: null, checked: 0, files: [], places: new Set() };
  const declaration = readTranslationDeclaration(path);
  const parsers = { md: parser({ mdx: false, math, site }), mdx: parser({ mdx: true, math, site }) };
  const files = [];
  const places = new Set();
  let checked = 0;
  for (const file of [...contentFiles(absRoot, globs, skip)].sort()) {
    if (!isSourcePage(declaration, file)) continue;
    checked += 1;
    const rel = relative(absRoot, file).replaceAll('\\', '/');
    const { body } = splitFrontmatter(readFileSync(file, 'utf8'));
    let findings;
    try {
      findings = codeLanguageFindings(parsers[file.endsWith('.mdx') ? 'mdx' : 'md'].parse(body), body, site?.codeLanguage);
    } catch (err) {
      files.push({ file: rel, errors: [`the page does not parse (npm run content:check says where): ${err.reason ?? err.message}`], warnings: [] });
      continue;
    }
    const errors = findings.filter((f) => f.severity === 'error').map(codeLanguageLine);
    const warnings = findings.filter((f) => f.severity === 'warning').map(codeLanguageLine);
    for (const f of findings) places.add(f.place);
    if (errors.length + warnings.length > 0) files.push({ file: rel, errors, warnings });
  }
  return { declaration: path, checked, files, places };
}

const USAGE = `usage: check-language.mjs [<root>] [--glob <pattern>]... [--skip <dir>]... [--config <path>] [--math]

  <root>             directory to scan (default .)
  --glob <pattern>   files to check, relative to <root> (repeatable; default
                     **/index.{md,mdx})
  --skip <dir>       a directory, relative to <root>, not to scan (repeatable)
  --config <path>    the site's plugin module (as for check-content): its
                     remark plugins' syntax is how a page is read, and its
                     codeLanguage export ('error', or places such as
                     { script: 'error' }) turns those places' findings into
                     errors
  --math             read $…$ as math without --config
  --help             print this usage

Every page under <root> in its own source language (by the i18n.config.json
over <root> and its i18n.lock) is read for Chinese in the code the translation
sync service copies from it into every other language: the script, attributes
of components and raw HTML other than the reader-facing ones, inline code, code
blocks outside their comments. A finding is a warning unless --config raises it.
Exit code: 0 no errors (warnings are listed and pass), 1 errors, 2 usage error.`;

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const valued = new Set(['--glob', '--skip', '--config']);
  const flags = new Set(['--math']);
  if (valued.has(argv[argv.length - 1])) {
    console.error(`${argv[argv.length - 1]} requires a value\n\n${USAGE}`);
    return 2;
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const unknown = argv.filter((a) => a.startsWith('--') && !valued.has(a) && !flags.has(a));
  if (positional.length > 1 || unknown.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const many = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const root = resolve(positional[0] ?? '.');
  try {
    if (!statSync(root).isDirectory()) throw new Error();
  } catch {
    console.error(`✗ content root does not exist or is not a directory: ${root}`);
    return 2;
  }
  let site;
  const configPath = many('config')[0];
  if (configPath !== undefined) {
    try {
      site = await loadSiteConfig(configPath);
    } catch (err) {
      console.error(`cannot load --config ${configPath}: ${err.message}`);
      return 2;
    }
  }
  const globs = many('glob');
  let result;
  try {
    result = await checkLanguage(root, { globs: globs.length > 0 ? globs : undefined, skip: many('skip'), math: argv.includes('--math'), site });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.error(`cannot read the translation declaration over ${root}: ${err.message}`);
    return 2;
  }
  if (result.declaration === null) {
    console.log(`✓ no i18n.config.json over ${root}: its pages are not translated by the sync service, and their code is written for one language`);
    return 0;
  }
  let errors = 0;
  let warnings = 0;
  for (const { file, errors: e, warnings: w } of result.files) {
    console.log(`\n${e.length > 0 ? '✗' : '⚠'} ${file}`);
    for (const line of e) console.log(`  ${line}`);
    for (const line of w) console.log(`  warning ${line}`);
    errors += e.length;
    warnings += w.length;
  }
  if (result.places.size > 0) console.log(codeLanguageAdvice(result.places));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const scope = `${plural(result.checked, 'source page')}; the other languages copy their code`;
  if (errors > 0) {
    console.log(`\n✗ ${plural(errors, 'error')} and ${plural(warnings, 'warning')}: Chinese in code every language shows as written (${scope}).`);
    return 1;
  }
  console.log(`\n✓ no errors${warnings > 0 ? `; ${plural(warnings, 'warning')}` : ''} (${scope}).`);
  return 0;
}

function isEntry() {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(await main(process.argv.slice(2)));
