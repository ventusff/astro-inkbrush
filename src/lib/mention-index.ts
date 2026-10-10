/**
 * mention-index — which handles a note's source mentions, for indexes (who
 * is mentioned where; subpath export astro-inkbrush/mentions/extract, Node
 * only). The source is parsed by the dialect's parser — the MDX grammar for
 * an .mdx source — and read with the same rules the page's remarkMentions
 * transform applies (./mentions.ts mentionsInTree), so an index counts a
 * mention exactly where a page renders one, given the same resolution.
 */
import { splitFrontmatter } from './frontmatter.ts';
import { mentionsInTree } from './mentions.ts';
import { parseSourceTree, type MaskOptions } from './wikilinks.ts';

export function extractMentions(source: string, options: Pick<MaskOptions, 'mdx'> = {}): Set<string> {
  const tree = parseSourceTree(source, options);
  return mentionsInTree(tree as never, splitFrontmatter(source).body);
}
