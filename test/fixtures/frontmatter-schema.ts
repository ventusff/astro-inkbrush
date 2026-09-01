/**
 * A frontmatter schema module in the shape check-content loads through
 * --frontmatter: a factory receiving Astro's zod, as a content repo would
 * write it beside its notes (no dependencies of its own).
 */
import type { z as Z } from 'astro/zod';

export default ({ z }: { z: typeof Z }) =>
  z.object({
    title: z.string(),
    sources: z.array(z.object({ title: z.string() })).max(2).default([]),
    tags: z.array(z.string()).default([]),
  });
