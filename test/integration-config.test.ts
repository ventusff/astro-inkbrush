/**
 * The dev-server configuration the integration contributes: the CMS's own
 * state directory is unwatched, the dev toolbar is off, the client entry is
 * injected, every package the client imports is pre-bundled — and outside
 * `astro dev` nothing happens at all.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import { CLIENT_DEPENDENCIES, inkbrush } from '../src/wiki/integration.ts';

const CLIENT_ENTRY = fileURLToPath(new URL('../src/wiki/client/index.ts', import.meta.url));

/** the module specifiers a file loads at run time: static imports and
 *  re-exports that are not type-only, and dynamic import() calls */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** a relative specifier as the bundler resolves it: as written, or with a
 *  TypeScript extension or index file added */
function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** every package the browser client reaches from its entry */
function clientPackages(): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        if (!/\.(?:[cm]?[jt]s|tsx?)$/.test(specifier) && /\.\w+$/.test(specifier)) continue; // a stylesheet or asset
        const target = resolveRelative(file, specifier);
        assert.ok(target, `${file}: cannot resolve ${specifier}`);
        walk(target);
      } else {
        packages.add(specifier);
      }
    }
  };
  walk(CLIENT_ENTRY);
  return packages;
}

interface Captured {
  updates: Record<string, unknown>[];
  scripts: string[];
  warnings: string[];
}

async function setup(command: 'dev' | 'build'): Promise<Captured> {
  const captured: Captured = { updates: [], scripts: [], warnings: [] };
  const hook = inkbrush().hooks['astro:config:setup'];
  assert.ok(hook);
  await hook({
    command,
    config: { root: pathToFileURL(`${process.cwd()}/`) },
    injectScript: (_stage: string, content: string) => {
      captured.scripts.push(content);
    },
    logger: {
      warn: (m: string) => {
        captured.warnings.push(m);
      },
      info: () => undefined,
      error: () => undefined,
    },
    updateConfig: (update: Record<string, unknown>) => {
      captured.updates.push(update);
      return update;
    },
  } as never);
  return captured;
}

test('under astro dev: .wiki/ is unwatched, the toolbar off, the client injected', async () => {
  const { updates, scripts, warnings } = await setup('dev');
  assert.equal(updates.length, 1);
  const update = updates[0]!;
  const vite = update['vite'] as { server: { watch: { ignored: string[] } } };
  assert.ok(vite.server.watch.ignored.includes('**/.wiki/**'));
  assert.deepEqual(update['devToolbar'], { enabled: false });
  // the client's dependencies are pre-bundled through the package that owns
  // them: the bare name is unresolvable from a pnpm site root, and the nested
  // form falls back to the root wherever the package itself is not resolvable
  const include = (vite as unknown as { optimizeDeps: { include: string[] } }).optimizeDeps.include;
  assert.deepEqual(include, CLIENT_DEPENDENCIES.map((dep) => `astro-inkbrush > ${dep}`));
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /client\/index\.ts/);
  assert.deepEqual(warnings, []);
});

test('outside astro dev the integration changes nothing', async () => {
  const { updates, scripts, warnings } = await setup('build');
  assert.deepEqual(updates, []);
  assert.deepEqual(scripts, []);
  assert.equal(warnings.length, 1);
});

test('the pre-bundled packages are exactly the ones the browser client imports', () => {
  assert.deepEqual([...CLIENT_DEPENDENCIES].sort(), [...clientPackages()].sort());
});
