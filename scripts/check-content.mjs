#!/usr/bin/env node
/**
 * check-content — a compile gate for content-repo CI: every md/mdx headed
 * for a page is compiled with the package's Markdown dialect and content
 * guard, exactly as astro-inkbrush/markdown's markdownProcessor mounts them
 * for the site, and — with --config — with the site's own plugins after
 * them, in the site's order. Syntax errors and silent deformations —
 * unpaired emphasis markers, `{…}` eaten by MDX evaluation, bullets left
 * behind by line wrapping, single-line `$$`, formulas KaTeX cannot render —
 * all turn CI red.
 *
 * What is checked without --config: parsing under the dialect (GFM with
 * single tilde off, CJK-friendly emphasis and strikethrough), the content
 * guard, and remark-math when --math is given. The site's own plugins —
 * wikilinks, directives, heading numbering, KaTeX options, anything that
 * rewrites or rejects content — run only when --config names them; the
 * same goes for rehype plugins. Astro's default smartypants pass (quotes
 * and dashes) is not applied.
 *
 * Frontmatter is parsed as YAML 1.2 (the `yaml` package; Astro reads the
 * same grammar). Two frontmatter findings: a YAML error, and a plain value
 * truncated by an unquoted ` #` (`summary: deploy #3 checklist` is the
 * value "deploy" followed by a comment).
 *
 * Usage (from the content repo root):
 *   node <engine>/scripts/check-content.mjs . --glob '**\/index.{md,mdx}' --math
 *
 *   <root>             directory to scan (default .)
 *   --glob <pattern>   files to check, relative to <root> (repeatable;
 *                      default **\/index.{md,mdx}). Only **, * and {a,b}
 *                      are understood.
 *   --skip <dir>       a directory, relative to <root>, not to scan
 *                      (repeatable; docs, _meta, node_modules, .git and
 *                      .github are always skipped)
 *   --config <path>    a JS/TS module exporting { remarkPlugins, rehypePlugins,
 *                      remarkRehype } (named exports or one default export)
 *                      — the same lists the site hands to markdownProcessor.
 *                      Mounted after the dialect and the guard; rehype
 *                      plugins after remark-rehype. Loaded with Node's
 *                      native TypeScript support.
 *   --math             mount remark-math (required for math sites without
 *                      --config: formula braces otherwise read as JSX
 *                      expressions in MDX). Not needed when --config already
 *                      lists remark-math.
 *   --help             print this usage
 *
 * Exit code: 0 clean, 1 findings, 2 usage error.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compile } from '@mdx-js/mdx';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { LineCounter, isScalar, parseDocument, visit } from 'yaml';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const { markdownSyntax } = await import(pathToFileURL(join(engineRoot, 'src/lib/markdown-syntax.ts')).href);
const { remarkContentGuard } = await import(pathToFileURL(join(engineRoot, 'src/lib/content-guard.ts')).href);

/* ---------------- site config ---------------- */

/**
 * Load the site's plugin module: `{ remarkPlugins?, rehypePlugins?,
 * remarkRehype? }` as named exports or as the default export. Absent lists
 * are empty; a non-array list is an error.
 */
export async function loadSiteConfig(path) {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const cfg = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const list = (name) => {
    const value = cfg[name] ?? [];
    if (!Array.isArray(value)) throw new Error(`${path}: export "${name}" must be an array of plugins`);
    return value;
  };
  return {
    remarkPlugins: list('remarkPlugins'),
    rehypePlugins: list('rehypePlugins'),
    remarkRehype: cfg.remarkRehype && typeof cfg.remarkRehype === 'object' ? cfg.remarkRehype : {},
  };
}

/* ---------------- file discovery ---------------- */

/** glob → regex: **, * and {a,b} only */
export function globToRe(glob) {
  const re = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`)
    .replace(/\*\*\//g, '⁂')
    .replace(/\*/g, '[^/]*')
    .replace(/⁂/g, '(?:[^/]+/)*');
  return new RegExp(`^${re}$`);
}

const ALWAYS_SKIPPED = ['docs', '_meta', 'node_modules', '.git', '.github'];

export function* contentFiles(root, globs, skip = []) {
  const patterns = globs.map(globToRe);
  const skips = new Set([...skip, ...ALWAYS_SKIPPED].map((d) => d.replace(/\/+$/, '')));
  const walk = function* (dir) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const rel = relative(root, p).replaceAll('\\', '/');
      if (statSync(p).isDirectory()) {
        if (!skips.has(rel)) yield* walk(p);
      } else if (patterns.some((re) => re.test(rel))) {
        yield p;
      }
    }
  };
  yield* walk(root);
}

/* ---------------- frontmatter ---------------- */

/** the frontmatter block Astro recognises: an optional BOM or leading blank
 *  lines, then `---` … `---` (LF or CRLF); group 1 is the YAML body */
const FRONTMATTER_RE = /(?:^\uFEFF?|^\s*\n)---([\s\S]*?\n)---/;

/** YAML errors and plain values cut short by a same-line ` #` comment */
export function checkFrontmatter(source) {
  const problems = [];
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return problems;
  const yamlStart = m.index + m[0].indexOf('---') + 3;
  const yamlLine = source.slice(0, yamlStart).split('\n').length - 1;
  const raw = m[1];
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter, logLevel: 'silent' });
  for (const err of doc.errors) {
    const line = err.linePos?.[0]?.line;
    const where = line !== undefined ? `frontmatter line ${yamlLine + line}: ` : 'frontmatter: ';
    problems.push(`${where}YAML ${err.code} — ${err.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')}`);
  }
  visit(doc, {
    Scalar(_key, node) {
      if (node.type !== 'PLAIN' || node.comment === undefined || !node.range) return;
      const tail = raw.slice(node.range[1], node.range[2]);
      if (!/^[^\n]*#/.test(tail)) return;
      const line = yamlLine + lineCounter.linePos(node.range[0]).line;
      problems.push(
        `frontmatter line ${line}: YAML reads \` #\` as a comment — the value is "${String(node.value)}" and the rest is dropped; quote the value`,
      );
    },
  });
  return problems;
}

/* ---------------- compile ---------------- */

/** the site's pipeline up to the point where a finding can surface: dialect
 *  → guard → (--math) → site remark plugins → remark-rehype → site rehype
 *  plugins */
export function buildPipeline({ math = false, site } = {}) {
  const remarkPlugins = [
    ...markdownSyntax(),
    remarkContentGuard,
    ...(math ? [remarkMath] : []),
    ...(site?.remarkPlugins ?? []),
  ];
  const rehypePlugins = site?.rehypePlugins ?? [];
  const remarkRehypeOptions = { allowDangerousHtml: true, passThrough: [], ...(site?.remarkRehype ?? {}) };
  return { remarkPlugins, rehypePlugins, remarkRehypeOptions };
}

/** Astro hands the parser the file with the frontmatter blanked to empty lines; same view here so line numbers match */
function bodyOf(source) {
  return source.replace(FRONTMATTER_RE, (block) => block.replace(/[^\r\n]+/g, ''));
}

export async function checkSource(source, { path, pipeline }) {
  const problems = checkFrontmatter(source);
  const body = bodyOf(source);
  try {
    if (path.endsWith('.mdx')) {
      await compile(
        { value: body, path },
        {
          remarkPlugins: pipeline.remarkPlugins,
          rehypePlugins: pipeline.rehypePlugins,
          remarkRehypeOptions: pipeline.remarkRehypeOptions,
        },
      );
    } else {
      const processor = unified()
        .use(remarkParse)
        .use(pipeline.remarkPlugins)
        .use(remarkRehype, pipeline.remarkRehypeOptions)
        .use(pipeline.rehypePlugins);
      const fileLike = {
        value: body,
        path,
        fail(reason) {
          throw new Error(reason);
        },
      };
      await processor.run(processor.parse(body), fileLike);
    }
  } catch (err) {
    const place = err.line !== undefined ? `${err.line}:${err.column ?? 1}  ` : '';
    problems.push(`${place}${err.reason ?? err.message}`);
  }
  return problems;
}

/**
 * Check every matching file under `root`. Returns per-file findings (files
 * without findings are omitted) and the number of files checked.
 */
export async function checkContent(root, { globs = ['**/index.{md,mdx}'], skip = [], math = false, site } = {}) {
  const absRoot = resolve(root);
  const pipeline = buildPipeline({ math, site });
  const findings = [];
  let checked = 0;
  for (const file of [...contentFiles(absRoot, globs, skip)].sort()) {
    checked += 1;
    const path = relative(absRoot, file).replaceAll('\\', '/');
    const problems = await checkSource(readFileSync(file, 'utf8'), { path, pipeline });
    if (problems.length > 0) findings.push({ file: path, problems });
  }
  return { checked, findings };
}

/* ---------------- CLI ---------------- */

const USAGE = `usage: check-content.mjs [<root>] [--glob <pattern>]... [--skip <dir>]... [--config <path>] [--math]

  <root>             directory to scan (default .)
  --glob <pattern>   files to check, relative to <root> (repeatable; default
                     **/index.{md,mdx}); only **, * and {a,b} are understood
  --skip <dir>       a directory, relative to <root>, not to scan (repeatable;
                     docs, _meta, node_modules, .git, .github always skipped)
  --config <path>    JS/TS module exporting { remarkPlugins, rehypePlugins,
                     remarkRehype } — the lists the site hands to
                     markdownProcessor; mounted after the dialect and the
                     guard, rehype plugins after remark-rehype
  --math             mount remark-math (required for math sites without
                     --config; not needed when --config lists remark-math)
  --help             print this usage

Every file is compiled with the package's Markdown dialect (GFM with single
tilde off, CJK-friendly emphasis) and the content guard; with --config, the
site's own plugins run after them. Frontmatter is parsed as YAML 1.2: a YAML
error and a plain value truncated by an unquoted \` #\` are findings.
Exit code: 0 clean, 1 findings, 2 usage error.`;

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const valued = new Set(['--glob', '--skip', '--config']);
  const flags = new Set(['--math']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const unknown = argv.filter((a) => a.startsWith('--') && !valued.has(a) && !flags.has(a));
  if (positional.length > 1 || unknown.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const many = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const globs = many('glob');
  const math = argv.includes('--math');
  const configPath = many('config')[0];

  let site;
  if (configPath !== undefined) {
    try {
      site = await loadSiteConfig(configPath);
    } catch (err) {
      console.error(`cannot load --config ${configPath}: ${err.message}`);
      return 2;
    }
  }

  const { checked, findings } = await checkContent(positional[0] ?? '.', {
    globs: globs.length > 0 ? globs : undefined,
    skip: many('skip'),
    math,
    site,
  });
  const scope = `dialect + content guard${math ? ' + math' : ''}${site ? ' + site plugins' : ''}`;
  for (const { file, problems } of findings) {
    console.error(`\n✗ ${file}`);
    for (const p of problems) console.error(`  ${p.split('\n').join('\n  ')}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length}/${checked} files have problems (${scope}).`);
    return 1;
  }
  console.log(`✓ ${checked} files pass (${scope})`);
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
