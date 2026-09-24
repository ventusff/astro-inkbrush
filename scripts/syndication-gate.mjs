#!/usr/bin/env node
/**
 * syndication-gate — the receiving wiki's side of syndication, run by its
 * own CI on a push to `syndicate/<origin>/<unit>`: another inkbrush wiki
 * has pushed a proposed copy of one of its notes (the unit: the note with
 * its sub-pages, demos, attachments and locale mirrors) as one commit on
 * this repository's published tip. Nothing of the sending wiki runs here;
 * this script verifies the submission with the engine's own rules, builds
 * the commit that promotes it onto the current tip, and lets the CI's
 * normal checks run on exactly that commit before it is pushed.
 *
 * Run inside a checkout of the receiving repository's OWN published
 * branch — never of the pushed branch: the submitted commit is the
 * sender's and nothing of it is executed or checked out before the gate
 * has judged it. `<remote>` points at the repository with an identity
 * that may push the published branch. The whole run is bound to one
 * staged commit — `--staged`, the sha the push delivered — read as git
 * objects (fetched from the remote by sha when the checkout lacks them)
 * and never through the staging branch: a submission replaced while this
 * one is checked is neither judged by its findings nor deleted. The only
 * content that reaches the working tree is the promoted commit: the
 * published tip with the validated unit directories.
 *
 *   syndication-gate.mjs prepare --branch <syndicate/<origin>/<unit>> --staged <sha> --origins <a,b>
 *       [--base main] [--remote origin] [--content-dir <dir>] [--locales en/,de/]
 *
 *     0. the branch's origin is one of `--origins` — the wikis this
 *        repository accepts copies from; any other is refused before
 *        anything is recorded (exit 2, no verdict);
 *     1. the branch name and the commit's Syndication-* trailers agree,
 *        and the unit is a note unit of this wiki (one id segment, not a
 *        reserved directory such as `_meta`, `docs` or `inbox`, not a
 *        locale directory);
 *     2. the commit changes only paths under the unit's directories
 *        (`<content-dir><prefix><unit>/` for the served locale prefixes);
 *     3. every entry under those directories is a regular file without a
 *        dot-prefixed segment, no note directory holds both index.md and
 *        index.mdx; a publish carries `origin` on every note (wiki = the
 *        origin, revision = the submitted one) and its files digest to
 *        that revision; a withdrawal leaves the directories empty;
 *     4. the unit's state on the current tip of `<base>` (fetched now)
 *        allows the submission: a foreign copy is never touched, a native
 *        note only with adopt, a copy only at the expected revision and,
 *        when it was changed here, only with force;
 *     5. the promoted commit — the tip with the unit's directories
 *        replaced by the staged ones, the staged commit's author and
 *        message — is built and checked out detached.
 *     stdout: the promoted commit's sha. Exit 0.
 *     A submission that breaks the contract is refused here: the verdict
 *     is recorded (as `finish --fail` records it) and the exit code is 2.
 *     Any other failure exits 1.
 *
 *   syndication-gate.mjs finish --branch <b> --staged <sha> --promoted <sha> --origins <a,b> --ok [--base main] [--remote origin]
 *
 *     Push the promoted commit — exactly the commit the checks ran on —
 *     to `<base>`. When the tip moved meanwhile the push is refused and
 *     the exit code is 3: the workflow runs `prepare` and the checks
 *     again on the new tip (nothing unchecked is ever pushed). Then the
 *     staging branch is deleted if it still points at `--staged` (a newer
 *     submission stays), and the unit's verdict file, if any, is removed
 *     from the verdicts branch.
 *
 *   syndication-gate.mjs finish --branch <b> --staged <sha> --promoted <sha> --origins <a,b> --fail [--problems <file>]
 *       [--base main] [--remote origin]
 *
 *     Record the verdict — the checks' output, at most 200 lines, about
 *     `--staged` — as `<origin>/<unit>.json` on the `syndication-verdicts`
 *     branch (a commit on its tip; a tip that moved means rebuilding the
 *     one-file change on it) and delete the staging branch if it still
 *     points at `--staged`. The sending wiki reads that branch. A
 *     promotion removes the unit's file.
 *
 * Defaults: --base main, --remote origin, --content-dir '' (the repository
 * root), --locales the engine's default table (en/, de/). `--origins` has
 * no default: without it the gate refuses to run. The push runs with the
 * CI's own git environment: a push that must trigger the repository's
 * deploy workflow cannot use GITHUB_TOKEN (pushes made with it start no
 * workflows); use a deploy key or an app token instead.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const lib = (name) => import(pathToFileURL(join(engineRoot, 'src/lib', name)).href);
const { copyOriginOf, inUnitRoots, unitNameProblem, unitRoots } = await lib('syndication-bundle.ts');
const { splitFrontmatter } = await lib('frontmatter.ts');
const gitLib = await lib('syndication-git.ts');
const { buildTree, changedPaths, commitInfo, commitTree, committerIdentity, git, GitError, listTree, push, readUnitInTree, revParse, writeBlobs } = gitLib;
const { decide, parseStagingBranch, parseSubmission, unitStateFrom, verdictPath, VERDICT_LINES, VERDICTS_BRANCH } = await lib('syndication-state.ts');
const { LOCALES } = await import(pathToFileURL(join(engineRoot, 'src/wiki/shared/locales.ts')).href);

const USAGE = `usage: syndication-gate.mjs prepare --branch <syndicate/<origin>/<unit>> --staged <sha> --origins <a,b> [--base main] [--remote origin] [--content-dir <dir>] [--locales <p/,p/>]
       syndication-gate.mjs finish --branch <b> --staged <sha> --promoted <sha> --origins <a,b> --ok [--base main] [--remote origin]
       syndication-gate.mjs finish --branch <b> --staged <sha> --promoted <sha> --origins <a,b> --fail [--problems <file>] [--base main] [--remote origin]
exit codes: 0 done · 2 the submission is refused (verdict recorded) · 3 the published tip moved, run prepare again · 1 the gate itself failed`;

/** a refusal of the submission: recorded as a verdict, exit code 2 */
class Refusal extends Error {
  constructor(problems, code, unrecorded = false) {
    super(problems[0]);
    this.problems = problems;
    this.code = code;
    /** refused without a verdict: the branch names no accepted origin */
    this.unrecorded = unrecorded;
  }
}

/* ---------------- arguments ---------------- */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { base: 'main', remote: 'origin', contentDir: '', locales: LOCALES.map((l) => l.prefix), ok: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--branch') opts.branch = value();
    else if (arg === '--base') opts.base = value();
    else if (arg === '--remote') opts.remote = value();
    else if (arg === '--content-dir') opts.contentDir = value().replace(/^\/+|\/+$/g, '');
    else if (arg === '--locales') opts.locales = value().split(',').map((p) => p.trim()).filter(Boolean);
    else if (arg === '--promoted') opts.promoted = value();
    else if (arg === '--staged') opts.staged = value();
    else if (arg === '--origins') opts.origins = value().split(',').map((o) => o.trim()).filter(Boolean);
    else if (arg === '--problems') opts.problems = value();
    else if (arg === '--ok') opts.ok = true;
    else if (arg === '--fail') opts.ok = false;
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.contentDir) opts.contentDir += '/';
  opts.locales = ['', ...opts.locales.filter((p) => p !== '')];
  return { command, opts };
}

/* ---------------- verdicts ---------------- */

async function identity(dir) {
  return (await committerIdentity(dir)) ?? { name: 'syndication gate', email: 'wiki@local' };
}

/**
 * Change one file of the verdicts branch: `<origin>/<unit>.json` written
 * (a refusal) or removed (a promotion). The change is declarative — the
 * branch's current tip with that one file set — so a tip that moved
 * meanwhile only means rebuilding on it: fetch, rebuild, push, up to five
 * times. A branch that does not exist yet starts from an empty tree.
 */
async function writeVerdictFile(dir, opts, path, text) {
  const ref = `refs/remotes/${opts.remote}/${VERDICTS_BRANCH}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let tip = null;
    try {
      await git(dir, ['fetch', '--quiet', opts.remote, `+refs/heads/${VERDICTS_BRANCH}:${ref}`]);
      tip = await revParse(dir, ref);
    } catch {
      tip = null;
    }
    const add = [];
    if (text !== null) {
      const blobs = await writeBlobs(dir, new Map([[path, new TextEncoder().encode(text)]]), mkdtempSync(join(tmpdir(), 'syndication-verdict-')));
      add.push({ path, sha: blobs.get(path) });
    } else if (tip === null || !(await listTree(dir, tip, path)).some((e) => e.path === path)) {
      return;
    }
    const tree = await buildTree(dir, { base: tip, remove: [path], add, indexFile: await indexFile(dir) });
    const who = await identity(dir);
    const commit = await commitTree(dir, {
      tree,
      parents: tip ? [tip] : [],
      message: text !== null ? `syndication: ${path} refused\n` : `syndication: ${path} resolved\n`,
      author: who,
      committer: who,
    });
    try {
      await push(dir, opts.remote, `${commit}:refs/heads/${VERDICTS_BRANCH}`);
      return;
    } catch (err) {
      if (!(err instanceof GitError) || attempt === 4) throw err;
    }
  }
}

/** record the verdict as `<origin>/<unit>.json` on the verdicts branch and delete the staging branch */
async function recordVerdict(dir, opts, target, verdict) {
  const text = JSON.stringify({ ...verdict, problems: verdict.problems.slice(0, VERDICT_LINES) }, null, 2);
  await writeVerdictFile(dir, opts, verdictPath(target.origin, target.unit), `${text}\n`);
  await deleteStaging(dir, opts);
}

/** delete the staging branch if it still points at the staged commit; a
 *  newer submission on it stays for its own run */
async function deleteStaging(dir, opts) {
  const ref = `refs/heads/${opts.branch}`;
  try {
    await git(dir, ['push', '--quiet', `--force-with-lease=${ref}:${opts.staged}`, opts.remote, `:${ref}`]);
  } catch (err) {
    if (!(err instanceof GitError && /stale info|remote ref does not exist|unable to delete/.test(err.stderr))) throw err;
  }
}

async function indexFile(dir) {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  return join(gitDir, `syndication-index-${process.pid}-${Date.now()}`);
}

/* ---------------- the promotion ---------------- */

/** the promoted commit: `tip` with the unit's directories replaced by the staged commit's */
async function promote(dir, opts, target, staged, tip) {
  const roots = unitRoots(target.unit, opts.locales).map((root) => `${opts.contentDir}${root}`);
  const { entries } = await readUnitInTree(dir, staged.sha, opts.contentDir, target.unit, opts.locales);
  const tree = await buildTree(dir, {
    base: tip,
    remove: roots,
    add: entries.map((e) => ({ path: e.path, sha: e.sha, mode: e.mode })),
    indexFile: await indexFile(dir),
  });
  return commitTree(dir, {
    tree,
    parents: tip ? [tip] : [],
    message: staged.message,
    author: { name: staged.authorName, email: staged.authorEmail, date: staged.authorDate },
    committer: await identity(dir),
  });
}

/** the current tip of the published branch on the remote, or null when it does not exist */
async function fetchTip(dir, opts) {
  try {
    await git(dir, ['fetch', '--quiet', opts.remote, `+refs/heads/${opts.base}:refs/remotes/${opts.remote}/${opts.base}`]);
  } catch (err) {
    if (err instanceof GitError && /couldn't find remote ref/.test(err.stderr)) return null;
    throw err;
  }
  return revParse(dir, `refs/remotes/${opts.remote}/${opts.base}`);
}

/** the origin and unit the branch names; an origin outside `--origins`
 *  is refused before anything is recorded */
function stagingTarget(opts) {
  const target = parseStagingBranch(opts.branch);
  if (!target) throw new Error(`${opts.branch} is not a staging branch (syndicate/<origin>/<unit>)`);
  if (!opts.origins.includes(target.origin)) {
    throw new Refusal([`'${target.origin}' is not a wiki this repository accepts copies from (--origins ${opts.origins.join(',')})`], undefined, true);
  }
  return target;
}

/* ---------------- prepare ---------------- */

/** the staged commit as an object of the checkout's repository, fetched
 *  by sha from the remote when it is not there yet */
async function stagedObject(dir, opts) {
  if (!/^[0-9a-f]{40}$/.test(opts.staged)) throw new Error(`--staged must be a full commit sha (got '${opts.staged}')`);
  try {
    return await revParse(dir, opts.staged);
  } catch {
    await git(dir, ['fetch', '--quiet', opts.remote, opts.staged]);
    return revParse(dir, opts.staged);
  }
}

async function prepare(dir, opts) {
  const target = stagingTarget(opts);
  const stagedSha = await stagedObject(dir, opts);
  const staged = await commitInfo(dir, stagedSha);
  const verdict = { staged: stagedSha, ok: false, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  try {
    const parsed = parseSubmission(staged.message);
    if (!parsed.ok) throw new Refusal([parsed.problem]);
    const s = parsed.submission;
    verdict.action = s.action;
    verdict.revision = s.revision;
    if (s.origin !== target.origin || s.unit !== target.unit) {
      throw new Refusal([`the branch names ${target.origin}/${target.unit}, the commit's trailers ${s.origin}/${s.unit}`]);
    }
    const unitProblem = unitNameProblem(target.unit, opts.locales);
    if (unitProblem) throw new Refusal([unitProblem]);

    const parent = staged.parents[0];
    const changed = parent
      ? (await git(dir, ['diff', '--name-only', '-z', parent, stagedSha])).split('\0').filter(Boolean)
      : (await listTree(dir, stagedSha)).map((e) => e.path);
    const outside = changed.filter((p) => !(p.startsWith(opts.contentDir) && inUnitRoots(p.slice(opts.contentDir.length), target.unit, opts.locales)));
    if (outside.length > 0) throw new Refusal([`the commit changes paths outside the unit's directories: ${outside.join(', ')}`]);

    const unit = await readUnitInTree(dir, stagedSha, opts.contentDir, target.unit, opts.locales);
    if (unit.problems.length > 0) throw new Refusal(unit.problems);
    if (s.action === 'publish') {
      const problems = [];
      for (const [rel, text] of unit.noteTexts) {
        const fm = splitFrontmatter(text);
        const origin = fm.error ? null : copyOriginOf(fm.data);
        if (!origin) problems.push(`${rel}: no origin block`);
        else if (origin.wiki !== s.origin) problems.push(`${rel}: origin.wiki is '${origin.wiki}', not '${s.origin}'`);
        else if (origin.revision !== s.revision) problems.push(`${rel}: origin.revision is ${origin.revision}, not ${s.revision}`);
      }
      if (!unit.noteTexts.has(`${target.unit}/index.md`) && !unit.noteTexts.has(`${target.unit}/index.mdx`)) {
        problems.push(`${target.unit}/index.md or index.mdx is missing`);
      }
      if (problems.length > 0) throw new Refusal(problems);
      if (unit.digest !== s.revision) {
        throw new Refusal([`the unit's files digest to ${unit.digest}, the commit says ${s.revision} — the two wikis compute revisions differently; update both engines`], 'digest-mismatch');
      }
    } else if (unit.entries.length > 0) {
      throw new Refusal([`a withdrawal must leave the unit's directories empty; found ${unit.entries.map((e) => e.path).join(', ')}`]);
    }

    const tip = await fetchTip(dir, opts);
    const roots = unitRoots(target.unit, opts.locales).map((root) => `${opts.contentDir}${root}`);
    if (tip) {
      // a file where the unit's directory would be: nothing can be placed there
      const fileAtRoot = (await listTree(dir, tip)).find((e) => roots.includes(e.path));
      if (fileAtRoot) throw new Refusal([`'${fileAtRoot.path}' is a file on ${opts.base}, not a directory — the unit cannot be placed there`], 'native');
    }
    const state = tip ? await unitStateOnTip(dir, opts, target, tip) : { kind: 'absent' };
    const decision = decide(state, s.expect, s.force, s.action);
    if (!decision.ok) throw new Refusal([decision.message], decision.code);

    const promoted = await promote(dir, opts, target, staged, tip);
    // the promotion, against the current tip, changes nothing outside the unit
    const outsideTip = (await changedPaths(dir, tip, promoted)).filter((p) => !roots.some((root) => p.startsWith(`${root}/`)));
    if (outsideTip.length > 0) throw new Refusal([`the promotion would change paths outside the unit's directories: ${outsideTip.join(', ')}`]);
    await git(dir, ['checkout', '--quiet', '--detach', promoted]);
    process.stdout.write(`${promoted}\n`);
    return 0;
  } catch (err) {
    // a failure the submission caused — an unreadable note, a YAML the
    // package refuses to convert — is a refusal like any other; the gate's
    // own failures (git, the filesystem) surface as errors
    if (!(err instanceof Refusal) && !(err instanceof GitError) && err instanceof Error && !/^E[A-Z]+:/.test(err.message) && !(err.code && typeof err.code === 'string')) {
      err = new Refusal([`the submission could not be read: ${err.message.split('\n')[0]}`]);
    }
    if (!(err instanceof Refusal)) throw err;
    await recordVerdict(dir, opts, target, { ...verdict, code: err.code, problems: err.problems });
    process.stderr.write(`refused: ${err.problems.join('\n')}\n`);
    return 2;
  }
}

/** the unit's state on the published tip */
async function unitStateOnTip(dir, opts, target, tip) {
  const unit = await readUnitInTree(dir, tip, opts.contentDir, target.unit, opts.locales);
  const originOf = (rel) => {
    const fm = splitFrontmatter(unit.noteTexts.get(rel));
    return fm.error ? null : copyOriginOf(fm.data);
  };
  // every physical note file counts: a second root file (index.md beside
  // index.mdx) is inside, whatever it says
  const rootPath = [`${target.unit}/index.md`, `${target.unit}/index.mdx`].find((p) => unit.noteTexts.has(p));
  const insideOrigins = [...unit.noteTexts.keys()]
    .filter((rel) => rel !== rootPath)
    .map((rel) => originOf(rel)?.wiki ?? null);
  return unitStateFrom({
    rootOrigin: rootPath ? originOf(rootPath) : undefined,
    insideOrigins,
    digest: unit.digest,
    name: target.origin,
  });
}

/* ---------------- finish ---------------- */

async function finish(dir, opts) {
  const target = stagingTarget(opts);
  if (!opts.promoted) throw new Error('--promoted <sha> is required');
  if (opts.ok === null) throw new Error('one of --ok / --fail is required');
  const promotedInfo = await commitInfo(dir, opts.promoted);
  const submission = parseSubmission(promotedInfo.message);
  const verdictBase = {
    staged: await stagedObject(dir, opts),
    ok: false,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    action: submission.ok ? submission.submission.action : undefined,
    revision: submission.ok ? submission.submission.revision : undefined,
  };

  if (opts.ok === false) {
    const text = opts.problems ? readFileSync(opts.problems, 'utf8') : '';
    const problems = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    await recordVerdict(dir, opts, target, { ...verdictBase, problems: problems.length ? problems : ['the checks failed'] });
    return 0;
  }

  try {
    await push(dir, opts.remote, `${opts.promoted}:refs/heads/${opts.base}`);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    if (/fetch first|non-fast-forward|rejected/.test(err.stderr)) {
      process.stderr.write(`${opts.base} moved since prepare — run prepare and the checks again\n`);
      return 3;
    }
    await recordVerdict(dir, opts, target, { ...verdictBase, problems: [`the promotion could not be pushed to ${opts.base}: ${err.summary}`] });
    process.stderr.write(`${err.stderr}\n`);
    return 1;
  }
  await deleteStaging(dir, opts);
  await writeVerdictFile(dir, opts, verdictPath(target.origin, target.unit), null);
  return 0;
}

/* ---------------- entry ---------------- */

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.opts.help || !parsed.command) {
      process.stdout.write(`${USAGE}\n`);
      return parsed.opts.help ? 0 : 1;
    }
    if (!parsed.opts.branch) throw new Error('--branch is required');
    if (!parsed.opts.staged) throw new Error('--staged <sha> is required');
    if (!parsed.opts.origins) throw new Error('--origins <a,b> is required: the wikis this repository accepts copies from');
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 1;
  }
  const dir = process.cwd();
  try {
    if (parsed.command === 'prepare') return await prepare(dir, parsed.opts);
    if (parsed.command === 'finish') return await finish(dir, parsed.opts);
  } catch (err) {
    if (err instanceof Refusal && err.unrecorded) {
      process.stderr.write(`refused: ${err.problems.join('\n')}\n`);
      return 2;
    }
    throw err;
  }
  process.stderr.write(`unknown command: ${parsed.command}\n${USAGE}\n`);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
