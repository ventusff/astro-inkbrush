/**
 * Preview of a block of an MDX note, rendered as the note's page renders it:
 * POST /render-block takes a block's source and answers the HTML the page
 * would show for it, components included. The block runs behind the
 * note's own import and export statements (read from the note on disk at
 * request time), so the components, data files and values the note imports
 * are in scope as they are on the page; the dev server compiles and renders
 * the result (../block-renderer.ts).
 */
import { readFileSync } from 'node:fs';

import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import type { BlockRenderer } from '../block-renderer.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, json, readBody } from './index.ts';
import { noteFile } from './source.ts';

let blockRenderer: BlockRenderer | undefined;

/** the dev server's block renderer, handed over by the integration */
export function setBlockRenderer(renderer: BlockRenderer | undefined): void {
  blockRenderer = renderer;
}

/** the top-level import and export statements of an MDX note's body, in order, each as written */
export function noteModuleStatements(body: string): string {
  const tree = unified().use(remarkParse).use(remarkMdx).parse(body);
  return tree.children
    .filter((node) => node.type === 'mdxjsEsm')
    .map((node) => body.slice(node.position!.start.offset, node.position!.end.offset))
    .join('\n');
}

export function registerBlockPreviewRoutes(on: RouteRegistrar): void {
  on(
    'POST',
    '/render-block',
    async ({ req, res }) => {
      const { note, source, page } = await readBody<{ note?: string; source?: string; page?: string }>(req);
      if (typeof note !== 'string' || typeof source !== 'string' || typeof page !== 'string') {
        return fail(res, 400, 'bad-request', { detail: 'note, source and page are required' });
      }
      const located = noteFile(note);
      if (!located?.file.endsWith('.mdx')) return fail(res, 400, 'bad-request', { detail: `${note} is not an MDX note` });
      if (!blockRenderer) return fail(res, 400, 'bad-request', { detail: 'components render only under astro dev' });
      const statements = noteModuleStatements(splitFrontmatter(readFileSync(located.file, 'utf8')).body);
      try {
        json(res, 200, { html: await blockRenderer(located.file, `${statements}\n\n${source}\n`, page) });
      } catch (err) {
        fail(res, 422, 'unexpected', { detail: err instanceof Error ? err.message : String(err) });
      }
    },
    { auth: true },
  );
}
