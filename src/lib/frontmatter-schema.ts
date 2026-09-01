/**
 * The frontmatter schema gate — a site's content-collection schema applied
 * to a note's frontmatter mapping, so the save gate, the check CLI and the
 * build refuse the same frontmatter.
 *
 * The schema is any object implementing the Standard Schema interface
 * (https://standardschema.dev — zod, valibot and arktype all do; Astro's
 * `astro/zod` schemas qualify as they are), so the engine takes no
 * dependency on a validation library. A schema module handed to the CLI
 * may export the schema itself or a factory `({ z }) => schema` that
 * receives Astro's own zod — the module a content repo keeps beside its
 * notes then needs no dependencies of its own, and the schema it builds is
 * the one the site's content collection runs.
 */
import { pathToFileURL } from 'node:url';

/** Standard Schema v1 — the spec's interface, as it asks to be copied */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** what a site hands over: its notes' frontmatter schema */
export type FrontmatterSchema = StandardSchemaV1<unknown, unknown>;

export function isStandardSchema(value: unknown): value is FrontmatterSchema {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const std = (value as { '~standard'?: unknown })['~standard'];
  return (
    std !== null &&
    typeof std === 'object' &&
    (std as { version?: unknown }).version === 1 &&
    typeof (std as { validate?: unknown }).validate === 'function'
  );
}

/** `a.b[2].c` for an issue path; '' for a root issue */
export function issuePath(path: StandardIssue['path']): string {
  if (!path || path.length === 0) return '';
  let out = '';
  for (const seg of path) {
    const key = typeof seg === 'object' && seg !== null ? seg.key : seg;
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

/**
 * The schema's findings for `data`, one line each — `frontmatter <path>:
 * <message>`, or `frontmatter: <message>` for a root issue. Empty when
 * `data` passes.
 */
export async function frontmatterProblems(schema: FrontmatterSchema, data: unknown): Promise<string[]> {
  const result = await schema['~standard'].validate(data);
  if (!result.issues) return [];
  return result.issues.map((issue) => {
    const at = issuePath(issue.path);
    return `frontmatter${at ? ` ${at}` : ''}: ${issue.message}`;
  });
}

/**
 * Load a schema module: its default export (or a `frontmatter` / `schema`
 * named export) is the schema, or a factory `({ z }) => schema` called with
 * Astro's zod. Throws with the reason when the module yields no schema.
 */
export async function loadFrontmatterSchema(modulePath: string): Promise<FrontmatterSchema> {
  const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const candidate = mod['default'] ?? mod['frontmatter'] ?? mod['schema'];
  if (candidate === undefined) {
    throw new Error(`${modulePath}: no default, "frontmatter" or "schema" export`);
  }
  let schema: unknown = candidate;
  if (typeof candidate === 'function' && !isStandardSchema(candidate)) {
    const { z } = await import('astro/zod');
    schema = await (candidate as (ctx: { z: typeof z }) => unknown)({ z });
  }
  if (!isStandardSchema(schema)) {
    throw new Error(`${modulePath}: the export is not a Standard Schema (no "~standard" interface)`);
  }
  return schema;
}
