#!/usr/bin/env node
/**
 * check-content — a compile gate for content-repo CI: every md/mdx headed for
 * a page is REALLY compiled with the exact same dialect the site renders
 * (astro-inkbrush/markdown's markdownSyntax + the content guard). Syntax
 * errors and silent deformations — unpaired emphasis markers, `{…}` eaten by
 * MDX evaluation, bullets left behind by line wrapping, single-line `$$`,
 * formulas KaTeX can't render — all turn CI red.
 *
 * Why the engine ships this script: a checker whose plugin set differs from
 * the site's is worse than no checker. Without remark-math it misreads
 * formula braces as JSX expressions (a measured source of false positives);
 * without GFM it waves through formulas swallowed by table pipes. The
 * dialect is written once, in the engine — the site's rendering, the CMS
 * save validation, and this script always agree.
 *
 * Usage (from the content repo root):
 *   node <engine>/scripts/check-content.mjs . --glob '**\/index.{md,mdx}' --math
 *
 *   --glob <pattern>   files to check (repeatable; default **\/index.{md,mdx}).
 *                      Only **, * and {a,b} are supported — enough, and no
 *                      extra dependency.
 *   --skip <dir>       top-level directories to skip (repeatable; default
 *                      docs and _meta — a content repo's engineering docs
 *                      never reach a page)
 *   --math             the site has remark-math on (REQUIRED for math sites,
 *                      or formula braces get misread as JSX expressions)
 *
 * Beyond compilation, two frontmatter silent-failure classes are checked: an
 * unquoted ` #` in a value (YAML treats it as a comment — `summary: deploy #3
 * checklist` truncates to "deploy"), and CRLF line endings (the frontmatter
 * regex only accepts LF, so titles silently fall back to slugs).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const { markdownSyntax } = await import(pathToFileURL(join(engineRoot, 'src/lib/markdown-syntax.ts')).href);
const { remarkContentGuard } = await import(pathToFileURL(join(engineRoot, 'src/lib/content-guard.ts')).href);

/* ---------------- CLI ---------------- */

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const globs = many('glob');
if (globs.length === 0) globs.push('**/index.{md,mdx}');
const skips = new Set([...many('skip'), 'docs', '_meta', 'node_modules', '.git', '.github']);
const math = args.includes('--math');

/** glob → regex: only **, * and {a,b} (all this ecosystem uses) */
function globToRe(glob) {
  const re = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`)
    .replace(/\*\*\//g, '⁂')
    .replace(/\*/g, '[^/]*')
    .replace(/⁂/g, '(?:[^/]+/)*');
  return new RegExp(`^${re}$`);
}
const patterns = globs.map(globToRe);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!skips.has(relative(root, p))) yield* files(p);
    } else if (patterns.some((re) => re.test(relative(root, p)))) yield p;
  }
}

/* ---------------- checks ---------------- */

const [{ compile }, { unified }, remarkParse, remarkMath] = await Promise.all([
  import('@mdx-js/mdx'),
  import('unified'),
  import('remark-parse').then((m) => m.default),
  import('remark-math').then((m) => m.default),
]);

const plugins = [...markdownSyntax(), remarkContentGuard, ...(math ? [remarkMath] : [])];

/** frontmatter silent failures: unquoted ` #` in a value; CRLF anywhere */
function checkSource(source) {
  const problems = [];
  if (source.includes('\r')) problems.push('file contains CRLF line endings — frontmatter parsing only accepts LF, titles silently fall back');
  const fm = /^---\n([\s\S]*?)\n---/.exec(source);
  if (fm) {
    fm[1].split('\n').forEach((line, i) => {
      const m = /^([A-Za-z_][\w-]*):\s+([^"'[{>|#].*)$/.exec(line);
      if (m && /\s#/.test(m[2])) {
        problems.push(`frontmatter line ${i + 2}: YAML treats \` #\` as a comment start — the value of "${m[1]}" gets silently truncated; quote the value`);
      }
    });
  }
  return problems;
}

async function checkFile(file) {
  const source = readFileSync(file, 'utf8');
  const problems = checkSource(source);
  // Astro blanks the frontmatter to empty lines before the parser sees the
  // file — keep the same view here so line numbers match
  const body = source.replace(/^---\n[\s\S]*?\n---/, (m) => m.replace(/[^\n]+/g, ''));
  try {
    if (file.endsWith('.mdx')) {
      await compile(body, { remarkPlugins: plugins });
    } else {
      const processor = unified().use(remarkParse).use(plugins);
      const fileLike = {
        value: body,
        path: relative(root, file),
        fail(reason) {
          throw new Error(reason);
        },
      };
      await processor.run(processor.parse(body), fileLike);
    }
  } catch (err) {
    const place = err.line !== undefined ? `:${err.line}:${err.column ?? 1}` : '';
    problems.push(`${place ? `${place.slice(1)}  ` : ''}${err.reason ?? err.message}`);
  }
  return problems;
}

let checked = 0;
let bad = 0;
for (const file of [...files(root)].sort()) {
  checked += 1;
  const problems = await checkFile(file);
  if (problems.length === 0) continue;
  bad += 1;
  console.error(`\n✗ ${relative(root, file)}`);
  for (const p of problems) console.error(`  ${p.split('\n').join('\n  ')}`);
}

if (bad > 0) {
  console.error(`\n${bad}/${checked} files have problems (same-dialect compile + content guard).`);
  process.exit(1);
}
console.log(`✓ ${checked} files pass (same-dialect compile + content guard${math ? ', math included' : ''})`);
