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
 * After the pipeline, the file's block map — the source line stamps the
 * in-place editor reads and writes blocks by — is verified: stamps must be
 * well-formed, disjoint and cover every block (src/lib/wiki-blocks-check.ts).
 * rehype-wiki-blocks is mounted here; a --config module must not list it.
 *
 * Frontmatter is parsed as YAML 1.2 (the `yaml` package; Astro reads the
 * same grammar). Two frontmatter findings: a YAML error, and a plain value
 * truncated by an unquoted ` #` (`summary: deploy #3 checklist` is the
 * value "deploy" followed by a comment). With --frontmatter, the parsed
 * mapping of every file (`{}` when the block is absent) must also satisfy
 * the site's schema — the check its content collection makes at build
 * time, run here before the build.
 *
 * Usage (from the content repo root):
 *   node <engine>/scripts/check-content.mjs . --glob '**\/index.{md,mdx}' --math
 *   node <engine>/scripts/check-content.mjs . --math --frontmatter _meta/schema.ts
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
 *   --frontmatter <path>
 *                      a JS/TS module whose default export (or `frontmatter`
 *                      / `schema` export) is the notes' frontmatter schema —
 *                      any Standard Schema (an `astro/zod` schema as it is)
 *                      — or a factory `({ z }) => schema` called with
 *                      Astro's zod, so a content repo's schema module needs
 *                      no dependencies. Every file's frontmatter mapping
 *                      must satisfy it.
 *   --allow-empty      accept a corpus with zero matching files (without it,
 *                      an empty corpus is a failure — it certifies nothing)
 *   --help             print this usage
 *
 * Exit code: 0 clean, 1 findings (a nonexistent root and an empty corpus
 * without --allow-empty included), 2 usage error.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
const { splitFrontmatter } = await import(pathToFileURL(join(engineRoot, 'src/lib/frontmatter.ts')).href);
const { frontmatterProblems, loadFrontmatterSchema } = await import(
  pathToFileURL(join(engineRoot, 'src/lib/frontmatter-schema.ts')).href
);
const { rehypeWikiBlocks } = await import(pathToFileURL(join(engineRoot, 'src/lib/rehype-wiki-blocks.ts')).href);
const { blockStampProblems } = await import(pathToFileURL(join(engineRoot, 'src/lib/wiki-blocks-check.ts')).href);

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

/**
 * Matching files under `root`. Symlinks are followed only while their real
 * path stays inside the root's real path, and each real directory is
 * visited once, under the first path that reaches it in name order — a
 * symlink cycle cannot recurse and a link out of the tree is not scanned.
 */
export function* contentFiles(root, globs, skip = []) {
  const patterns = globs.map(globToRe);
  const skips = new Set([...skip, ...ALWAYS_SKIPPED].map((d) => d.replace(/\/+$/, '')));
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return;
  }
  const insideRoot = (real) => real === rootReal || real.startsWith(rootReal + sep);
  const visited = new Set([rootReal]);
  const walk = function* (dir, realDir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const rel = relative(root, p).replaceAll('\\', '/');
      let real = join(realDir, name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          real = realpathSync(p);
          const stat = statSync(real);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
        if (!insideRoot(real)) continue;
      }
      if (isDirectory) {
        if (skips.has(rel) || visited.has(real)) continue;
        visited.add(real);
        yield* walk(p, real);
      } else if (isFile && patterns.some((re) => re.test(rel))) {
        yield p;
      }
    }
  };
  yield* walk(root, rootReal);
}

/* ---------------- frontmatter ---------------- */

/** YAML errors and plain values cut short by a same-line ` #` comment.
 *  Block discovery is the shared splitter's (src/lib/frontmatter.ts); the
 *  YAML is re-parsed here with a LineCounter so every error and every
 *  comment-truncated scalar is reported, each on its file line. */
export function checkFrontmatter(source) {
  const problems = [];
  const fm = splitFrontmatter(source);
  if (!fm.present) return problems;
  // block line n sits on file line yamlLine + n
  const yamlLine = fm.contentLine - 1;
  const raw = fm.raw;
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

/** the editor's block map for the file must be sound: stamps well-formed,
 *  disjoint and covering every block */
function rehypeBlockStamps() {
  return (tree, file) => {
    const lines = typeof file.value === 'string' ? file.value.split('\n').length : undefined;
    const problems = blockStampProblems(tree, lines);
    if (problems.length > 0) file.fail(`block stamps: ${problems.join('; ')}`);
  };
}

/** the site's pipeline up to the point where a finding can surface: dialect
 *  → guard → (--math) → site remark plugins → remark-rehype → site rehype
 *  plugins → block stamps and their check */
export function buildPipeline({ math = false, site } = {}) {
  const remarkPlugins = [
    ...markdownSyntax(),
    remarkContentGuard,
    ...(math ? [remarkMath] : []),
    ...(site?.remarkPlugins ?? []),
  ];
  const rehypePlugins = [...(site?.rehypePlugins ?? []), rehypeWikiBlocks, rehypeBlockStamps];
  const remarkRehypeOptions = { allowDangerousHtml: true, passThrough: [], ...(site?.remarkRehype ?? {}) };
  return { remarkPlugins, rehypePlugins, remarkRehypeOptions };
}

export async function checkSource(source, { path, pipeline, frontmatter }) {
  const problems = checkFrontmatter(source);
  const fm = splitFrontmatter(source);
  // a block that does not parse is reported as such; its mapping is empty
  // and not worth a second finding
  if (frontmatter && !fm.error) problems.push(...(await frontmatterProblems(frontmatter, fm.data)));
  const body = fm.body;
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
 * @param {string} root
 * @param {{ globs?: string[], skip?: string[], math?: boolean, allowEmpty?: boolean,
 *           site?: { remarkPlugins: unknown[], rehypePlugins: unknown[], remarkRehype?: unknown },
 *           frontmatter?: import('../src/lib/frontmatter-schema.ts').FrontmatterSchema }} [options]
 */
export async function checkContent(
  root,
  { globs = ['**/index.{md,mdx}'], skip = [], math = false, site, frontmatter } = {},
) {
  const absRoot = resolve(root);
  const pipeline = buildPipeline({ math, site });
  const findings = [];
  let checked = 0;
  for (const file of [...contentFiles(absRoot, globs, skip)].sort()) {
    checked += 1;
    const path = relative(absRoot, file).replaceAll('\\', '/');
    const problems = await checkSource(readFileSync(file, 'utf8'), { path, pipeline, frontmatter });
    if (problems.length > 0) findings.push({ file: path, problems });
  }
  return { checked, findings };
}

/* ---------------- CLI ---------------- */

const USAGE = `usage: check-content.mjs [<root>] [--glob <pattern>]... [--skip <dir>]... [--config <path>] [--frontmatter <path>] [--math] [--allow-empty]

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
  --frontmatter <path>
                     JS/TS module whose default export (or \`frontmatter\` /
                     \`schema\` export) is the notes' frontmatter schema: any
                     Standard Schema (an astro/zod schema as it is), or a
                     factory ({ z }) => schema called with Astro's zod; every
                     file's frontmatter mapping must satisfy it
  --allow-empty      accept a corpus with zero matching files (without it, an
                     empty corpus fails — it certifies nothing)
  --help             print this usage

Every file is compiled with the package's Markdown dialect (GFM with single
tilde off, CJK-friendly emphasis) and the content guard; with --config, the
site's own plugins run after them. Frontmatter is parsed as YAML 1.2: a YAML
error and a plain value truncated by an unquoted \` #\` are findings; with
--frontmatter, so is a mapping the schema rejects.
Exit code: 0 clean, 1 findings (a nonexistent root and an empty corpus
without --allow-empty included), 2 usage error.`;

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const valued = new Set(['--glob', '--skip', '--config', '--frontmatter']);
  const flags = new Set(['--math', '--allow-empty']);
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
  const globs = many('glob');
  const math = argv.includes('--math');
  const allowEmpty = argv.includes('--allow-empty');
  const configPath = many('config')[0];
  const schemaPath = many('frontmatter')[0];

  const root = resolve(positional[0] ?? '.');
  let rootStat = null;
  try {
    rootStat = statSync(root);
  } catch {
    /* reported below */
  }
  if (rootStat === null || !rootStat.isDirectory()) {
    console.error(`✗ content root does not exist or is not a directory: ${root}`);
    return 1;
  }

  let site;
  if (configPath !== undefined) {
    try {
      site = await loadSiteConfig(configPath);
    } catch (err) {
      console.error(`cannot load --config ${configPath}: ${err.message}`);
      return 2;
    }
  }

  let frontmatter;
  if (schemaPath !== undefined) {
    try {
      frontmatter = await loadFrontmatterSchema(resolve(schemaPath));
    } catch (err) {
      console.error(`cannot load --frontmatter ${schemaPath}: ${err.message}`);
      return 2;
    }
  }

  const { checked, findings } = await checkContent(root, {
    globs: globs.length > 0 ? globs : undefined,
    skip: many('skip'),
    math,
    site,
    frontmatter,
  });
  const scope = `dialect + content guard${math ? ' + math' : ''}${site ? ' + site plugins' : ''}${frontmatter ? ' + frontmatter schema' : ''} + block stamps`;
  for (const { file, problems } of findings) {
    console.error(`\n✗ ${file}`);
    for (const p of problems) console.error(`  ${p.split('\n').join('\n  ')}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length}/${checked} files have problems (${scope}).`);
    return 1;
  }
  if (checked === 0 && !allowEmpty) {
    console.error(`✗ no files matched under ${root} — an empty corpus certifies nothing (pass --allow-empty when that is intended)`);
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
