import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// One note = one directory: src/content/notes/<id>/index.md. The generated
// entry id equals the engine's note id (`welcome`, `zh/welcome`), which is
// what the page passes back via <meta name="inkbrush-note">.
const notes = defineCollection({
  loader: glob({
    base: './src/content/notes',
    pattern: '**/index.md',
    generateId: ({ entry }) => entry.replace(/\/index\.md$/, ''),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    aliases: z.array(z.string()).default([]),
  }),
});

export const collections = { notes };
