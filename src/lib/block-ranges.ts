/**
 * remarkBlockRanges — records the source line range of every top-level block
 * of the parsed tree in `file.data`, for the block stamper
 * (rehype-wiki-blocks).
 *
 * A rehype plugin that renders a block into fresh nodes — rehype-katex with a
 * display formula — leaves the result without a position. One such block is
 * located by the gap between its positioned neighbours; two written back to
 * back share a gap no line can divide. The parsed tree knows where each one
 * is, and this list carries that knowledge across the rewrite.
 *
 * Read-only, and part of the dialect (markdownSyntax), so it runs on the
 * freshly parsed tree, ahead of every transformer. Lines are relative to the
 * parsed value, like every node position in the pipeline. Imports nothing:
 * the dialect also ships in browser bundles.
 */
export interface BlockRange {
  start: number;
  end: number;
}

interface Positioned {
  position?: { start: { line: number }; end: { line: number } } | undefined;
}

interface FileLike {
  data: Record<string, unknown>;
}

const KEY = 'wikiBlockRanges';

export function remarkBlockRanges() {
  return (tree: { children: Positioned[] }, file: FileLike): void => {
    const ranges: BlockRange[] = [];
    for (const node of tree.children) {
      if (node.position) ranges.push({ start: node.position.start.line, end: node.position.end.line });
    }
    file.data[KEY] = ranges;
  };
}

/** the ranges remarkBlockRanges recorded for this file; empty when the
 *  pipeline was not built on the dialect */
export function recordedBlockRanges(file: FileLike): BlockRange[] {
  const ranges = file.data[KEY];
  return Array.isArray(ranges) ? (ranges as BlockRange[]) : [];
}
