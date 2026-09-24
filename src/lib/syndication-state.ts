/**
 * syndication-state — the rules a submission must satisfy against the
 * unit's state on the peer, and the commit grammar that carries a
 * submission's intent from the origin to the peer's gate. Both sides run
 * exactly this code: the origin refuses locally what the gate would
 * refuse, and the gate re-decides on the peer's current tip.
 *
 * The staging commit's message names what it does, in trailers:
 *
 *   wiki: <unit> synced from <origin> (<revision>)
 *
 *   Syndication-Origin: <origin>
 *   Syndication-Unit: <unit>
 *   Syndication-Action: publish
 *   Syndication-Expect: none | adopt | <revision>
 *   Syndication-Revision: <revision>
 *   Syndication-Force: yes                  (only when forced)
 *
 * A withdrawal is `wiki: <unit> withdrawn by <origin>` with Action
 * withdraw and no Revision. The staging branch is
 * `syndicate/<origin>/<unit>`; a refusal is recorded as
 * `<origin>/<unit>.json` on the peer's `syndication-verdicts` branch.
 */
import type { SyndicationConflict } from '../wiki/shared/types.ts';

/** a wiki name or peer id: lowercase letters, digits and dashes */
export const SYNDICATION_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** a revision: sixteen lowercase hex characters */
export const REVISION = /^[0-9a-f]{16}$/;

/* ---------------- the state machine ---------------- */

/** what the peer holds at the unit's id */
export type UnitState =
  | { kind: 'absent' }
  /** a note of the peer's own */
  | { kind: 'native' }
  /** a copy from this origin: the recorded revision, and the digest of the copy as it is */
  | { kind: 'copy'; revision: string; digest: string }
  /** a copy from another origin */
  | { kind: 'foreign'; wiki: string };

/**
 * The unit's state from what the peer's tip holds: its root note's origin
 * stamp (undefined = no root note), the origin stamps of the other notes
 * inside the unit's directories, and the digest of the unit's files there.
 * A copy of another wiki's anywhere inside the directories makes the unit
 * foreign, whatever else is there; otherwise the peer's own notes make it
 * native — a publish would replace them.
 */
export function unitStateFrom(input: {
  rootOrigin: { wiki: string; revision: string } | null | undefined;
  insideOrigins: ReadonlyArray<string | null>;
  digest: string;
  name: string;
}): UnitState {
  const { rootOrigin } = input;
  if (rootOrigin && rootOrigin.wiki !== input.name) return { kind: 'foreign', wiki: rootOrigin.wiki };
  const foreign = input.insideOrigins.find((o) => o !== null && o !== input.name);
  if (foreign) return { kind: 'foreign', wiki: foreign };
  if (rootOrigin) return { kind: 'copy', revision: rootOrigin.revision, digest: input.digest };
  if (rootOrigin === null || input.insideOrigins.some((o) => o === null)) return { kind: 'native' };
  return { kind: 'absent' };
}

/** what the origin expects to find: nothing, a native note to adopt, or its own copy at a revision */
export type Expectation = 'none' | 'adopt' | { revision: string };

export type Decision = { ok: true } | { ok: false; code: SyndicationConflict; message: string; revision?: string | undefined };

/**
 * Whether a submission may proceed against `state`. A foreign copy is
 * never touched; a native note only when adoption is explicit; a copy
 * only at the revision the origin saw, and only with force when it was
 * changed on the peer; an absent unit only when nothing was expected (a
 * copy the origin expected has gone).
 */
export function decide(state: UnitState, expect: Expectation, force: boolean, action: 'publish' | 'withdraw'): Decision {
  switch (state.kind) {
    case 'foreign':
      return { ok: false, code: 'foreign', message: `the peer holds a copy from '${state.wiki}' at this id` };
    case 'native':
      if (action === 'publish' && expect === 'adopt') return { ok: true };
      return { ok: false, code: 'native', message: 'the peer holds a note of its own at this id' };
    case 'absent':
      if (action === 'publish' && (expect === 'none' || expect === 'adopt')) return { ok: true };
      return { ok: false, code: 'gone', message: 'the peer holds no copy at this id' };
    case 'copy':
      if (typeof expect === 'string' || expect.revision !== state.revision) {
        return {
          ok: false,
          code: 'moved',
          message: `the copy on the peer is at revision ${state.revision}, not the one expected`,
          revision: state.revision,
        };
      }
      if (state.digest !== state.revision && !force) {
        return { ok: false, code: 'changed', message: 'the copy was changed on the peer after it was received' };
      }
      return { ok: true };
  }
}

/* ---------------- the commit grammar ---------------- */

export interface Submission {
  origin: string;
  unit: string;
  action: 'publish' | 'withdraw';
  expect: Expectation;
  /** present for a publish */
  revision?: string | undefined;
  force: boolean;
}

export function stagingBranch(origin: string, unit: string): string {
  return `syndicate/${origin}/${unit}`;
}

/** the branch the peer's gate records its refusals on: one file per unit,
 *  `<origin>/<unit>.json`, written and removed by the gate alone (a branch
 *  the peer's rulesets keep senders out of) */
export const VERDICTS_BRANCH = 'syndication-verdicts';

export function verdictPath(origin: string, unit: string): string {
  return `${origin}/${unit}.json`;
}

/** the origin and unit a staging branch names, or null for any other branch */
export function parseStagingBranch(branch: string): { origin: string; unit: string } | null {
  const m = /^syndicate\/([^/]+)\/([^/]+)$/.exec(branch);
  return m ? { origin: m[1]!, unit: m[2]! } : null;
}

export function expectationText(expect: Expectation): string {
  return typeof expect === 'string' ? expect : expect.revision;
}

/** the staging commit's full message */
export function submissionMessage(s: Submission): string {
  const subject =
    s.action === 'publish' ? `wiki: ${s.unit} synced from ${s.origin} (${s.revision})` : `wiki: ${s.unit} withdrawn by ${s.origin}`;
  const trailers = [
    `Syndication-Origin: ${s.origin}`,
    `Syndication-Unit: ${s.unit}`,
    `Syndication-Action: ${s.action}`,
    `Syndication-Expect: ${expectationText(s.expect)}`,
    ...(s.action === 'publish' ? [`Syndication-Revision: ${s.revision}`] : []),
    ...(s.force ? ['Syndication-Force: yes'] : []),
  ];
  return `${subject}\n\n${trailers.join('\n')}\n`;
}

/** the `Key: value` trailers of a commit message (its last paragraph) */
function trailersOf(message: string): Map<string, string> {
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
  const out = new Map<string, string>();
  for (const line of (paragraphs[paragraphs.length - 1] ?? '').split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** the submission a staging commit's message describes, or the reason it describes none */
export function parseSubmission(message: string): { ok: true; submission: Submission } | { ok: false; problem: string } {
  const t = trailersOf(message);
  const origin = t.get('Syndication-Origin') ?? '';
  const unit = t.get('Syndication-Unit') ?? '';
  const action = t.get('Syndication-Action');
  const expect = t.get('Syndication-Expect') ?? '';
  const revision = t.get('Syndication-Revision');
  const force = t.get('Syndication-Force') === 'yes';
  if (!SYNDICATION_NAME.test(origin)) return { ok: false, problem: 'Syndication-Origin trailer missing or malformed' };
  if (!unit || unit.includes('/') || unit.startsWith('.')) return { ok: false, problem: 'Syndication-Unit trailer missing or malformed' };
  if (action !== 'publish' && action !== 'withdraw') return { ok: false, problem: 'Syndication-Action must be publish or withdraw' };
  if (expect !== 'none' && expect !== 'adopt' && !REVISION.test(expect)) {
    return { ok: false, problem: 'Syndication-Expect must be none, adopt or a revision' };
  }
  if (action === 'publish' && !(revision && REVISION.test(revision))) {
    return { ok: false, problem: 'Syndication-Revision missing or malformed' };
  }
  return {
    ok: true,
    submission: {
      origin,
      unit,
      action,
      expect: expect === 'none' || expect === 'adopt' ? expect : { revision: expect },
      revision: action === 'publish' ? revision : undefined,
      force,
    },
  };
}

/* ---------------- the verdict ---------------- */

/** `verdict.json` in a refusal's tree */
export interface Verdict {
  /** the staging commit the verdict is about */
  staged: string;
  ok: false;
  code?: SyndicationConflict | undefined;
  problems: string[];
  /** ISO time of the refusal */
  at: string;
}

/** a verdict's problems are capped at this many lines */
export const VERDICT_LINES = 200;
