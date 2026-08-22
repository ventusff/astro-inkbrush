/**
 * A site plugin module in the shape check-content and check-wikilinks load
 * through --config: the lists a site hands to markdownProcessor, plus the
 * remarkWikilinks options object.
 */
import { buildWikilinkResolver } from '../../src/lib/wikilinks.ts';

interface TextNode {
  type: string;
  value?: string;
  children?: TextNode[];
}

interface FileLike {
  fail: (reason: string) => never;
}

/** fails the file when prose contains the word FORBIDDEN */
function remarkForbidden() {
  return (tree: TextNode, file: FileLike): void => {
    const walk = (n: TextNode): void => {
      if (n.type === 'text' && n.value?.includes('FORBIDDEN')) file.fail('site plugin: FORBIDDEN is not allowed');
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** fails the file on an <h6> element */
function rehypeNoH6() {
  return (tree: TextNode & { tagName?: string }, file: FileLike): void => {
    const walk = (n: TextNode & { tagName?: string }): void => {
      if (n.type === 'element' && n.tagName === 'h6') file.fail('site rehype plugin: headings stop at h5');
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

export const remarkPlugins = [remarkForbidden];
export const rehypePlugins = [rehypeNoH6];

export const wikilinks = {
  resolve: buildWikilinkResolver({
    notes: () => [
      { id: 'site-only', title: 'Site Only', aliases: ['compost-heap'] },
      { id: 'sample-note', title: 'Sample Note', aliases: [] },
      { id: 'beta', title: 'Beta', aliases: [] },
    ],
    urlFor: (id: string) => `/n/${id}/`,
  }),
  slugifyAnchor: (raw: string) => `h-${raw.toLowerCase().replace(/\s+/g, '_')}`,
  noteIdOf: (path: string | undefined) => path?.match(/notes\/(.+)\/index\.mdx?$/)?.[1],
};
