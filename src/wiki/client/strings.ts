/**
 * UI strings — the single i18n layer for the wiki chrome.
 *
 * The chrome speaks the language of the page it edits: the page's
 * `<html lang>` (the site's own declared language — no config knob) picks
 * zh, de or en once at module load; any other language gets en.
 *
 * Every table implements the same `Strings` interface, so a missing key in
 * any language is a type error. Strings that interpolate data are functions.
 * A failure arrives from the server as a code with parameters
 * (../shared/errors.ts) and is worded here; Claude's tool labels arrive in
 * English and each table maps the well-known tool verbs, passing the path
 * through.
 */
import {
  ENGLISH_ERRORS,
  isWikiFailure,
  wordFailure,
  type ErrorTable,
  type ShareAction,
  type WikiFailure,
} from '../shared/errors.ts';
import type {
  JobNotice,
  LoginErrorCode,
  ShareProgress,
  ShareStage,
  SyndicationErrorCode,
  SyndicationStage,
  SyndicationWarning,
  WikiUser,
} from '../shared/types';
import { ApiError } from './api.ts';
import type { Standing } from './syndication';
import type { Action, Outcome } from './syndication-state';

export type UiLocale = 'en' | 'zh' | 'de';

export const UI_LOCALES: readonly UiLocale[] = ['en', 'zh', 'de'];

/** the chrome's language for a page's language tag (BCP 47): its primary
 *  subtag when the chrome speaks it, English otherwise */
export function uiLocaleOf(lang: string): UiLocale {
  const primary = lang.trim().toLowerCase().split('-')[0] ?? '';
  return (UI_LOCALES as readonly string[]).includes(primary) ? (primary as UiLocale) : 'en';
}

export const uiLocale: UiLocale = uiLocaleOf(globalThis.document?.documentElement.lang ?? '');

/** BCP 47 tag for Intl formatting. */
export const dateLocale = ({ en: 'en-GB', zh: 'zh-CN', de: 'de-DE' } as const)[uiLocale];

/** a note language's name as the page names it: the locale table's own
 *  label on a Chinese page, the name in the page's language elsewhere (a
 *  code Intl does not know keeps the label) */
export function languageName(code: string, label: string): string {
  if (uiLocale === 'zh') return label;
  try {
    return new Intl.DisplayNames([dateLocale], { type: 'language' }).of(code) ?? label;
  } catch {
    return label;
  }
}

/** Date display style: `datetime` = medium date + short time, `date` = medium date. */
export type DateStyle = 'datetime' | 'date';

const dateFormats: Record<DateStyle, Intl.DateTimeFormat> = {
  datetime: new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }),
  date: new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium' }),
};

/** The single locale-aware date formatter for every date the chrome shows. */
export function formatDate(value: number | string | Date, style: DateStyle = 'datetime'): string {
  return dateFormats[style].format(new Date(value));
}

/** A Claude tool label is `<verb> <path>` (path optional); only the verb is
 *  translatable, the path is passed through verbatim. */
function translateTool(label: string, verbs: Record<string, string>): string {
  const space = label.indexOf(' ');
  const verb = space < 0 ? label : label.slice(0, space);
  const rest = space < 0 ? '' : label.slice(space);
  return `${verbs[verb] ?? verb}${rest}`;
}

export interface Strings {
  common: {
    requestFailed: string;
    /** Claude tool-activity labels stream from the server in English;
     *  each table maps the known verbs and passes the path through. */
    tool: (label: string) => string;
    /** a failure without a code this client knows, by HTTP status (0: no
     *  answer arrived) */
    http: (status: number) => string;
  };
  /** every failure the server reports, by code */
  errors: ErrorTable;
  auth: {
    chipLabel: string;
    accountPanel: string;
    signIn: string;
    panelTitle: string;
    googleButton: string;
    samlButton: string;
    notConfigured: string;
    googleMissingEnv: string;
    samlMissingConfig: string;
    devLoginLabel: string;
    nickname: string;
    emailPlaceholder: string;
    enter: string;
    or: string;
    signOut: string;
    signedIn: (name: string) => string;
    signedOut: string;
    signInFailed: string;
    /** message for a `?login_error=<code>` redirect from a provider flow */
    loginError: (code: string) => string;
    provider: Record<WikiUser['provider'], string>;
    noProviders: string;
    role: (role: string | null | undefined) => string;
    members: string;
    rename: string;
    nameField: string;
    renamedSelf: (name: string) => string;
  };
  identity: {
    title: string;
    count: (n: number) => string;
    lede: string;
    searchPlaceholder: string;
    close: string;
    noMatch: (query: string) => string;
    nameLabel: (email: string) => string;
    renamed: (name: string) => string;
    you: string;
    roleLabel: (name: string) => string;
    aliasesLabel: string;
    aliasHint: string;
    aliasPlaceholder: string;
    addAlias: string;
    addAliasLabel: (name: string) => string;
    removeAlias: (alias: string) => string;
    aliasAdded: (alias: string) => string;
    addTitle: string;
    colEmail: string;
    colName: string;
    colRole: string;
    namePlaceholder: string;
    emailPlaceholder: string;
    add: string;
    added: (name: string) => string;
    remove: string;
    removeLabel: (name: string) => string;
    confirmRemove: (name: string) => string;
    confirmRemoveShort: string;
    removed: (name: string) => string;
    saved: string;
    saveFailed: string;
    loadFailed: string;
    emailRequired: string;
    adminNote: (role: string) => string;
  };
  blocks: {
    toolbar: string;
    focusHint: string;
    edit: string;
    ai: string;
    history: string;
    signInFirst: string;
    editorLoadFailed: string;
    aiLoadFailed: string;
    historyLoadFailed: string;
  };
  editor: {
    title: (jsx: string | null) => string;
    frontmatterTitle: string;
    shortcutHint: string;
    placeholder: string;
    frontmatterPlaceholder: string;
    save: string;
    cancel: string;
    validating: string;
    savedReloading: string;
    saved: string;
    saveFailed: string;
    readFailed: string;
    empty: string;
    previewFailed: string;
    jsxNoPreview: (name: string | null) => string;
    frontmatterNoPreview: string;
  };
  ai: {
    title: (start: number, end: number) => string;
    placeholder: (jsx: string | null) => string;
    inputLabel: string;
    run: string;
    working: string;
    done: string;
    jobFailed: string;
    /** added to an edit job's failure: nothing was written */
    unchanged: string;
    streamEnded: string;
    quick: Array<{ label: string; instruction: string }>;
  };
  chat: {
    title: string;
    dialogLabel: string;
    fabTitle: string;
    inputPlaceholder: string;
    inputLabel: string;
    send: string;
    newChat: string;
    collapse: string;
    thinking: string;
    emptyHint: string;
    newChatStarted: string;
    signInFirst: string;
    translateConfirm: (label: string) => string;
    translateAction: (label: string) => string;
    translateDone: string;
    streamEnded: string;
    /** what the server adds to a finished job's summary */
    notice: Record<JobNotice, string>;
  };
  history: {
    via: Record<'manual' | 'claude' | 'translate' | 'inbox' | 'revert', string>;
    title: (start: number, end: number) => string;
    wholeFile: string;
    wholeFileNote: string;
    viewDiff: string;
    revert: string;
    revertTitle: string;
    reverted: string;
    revertFailed: string;
    signInToRevert: string;
    noRecords: string;
    loadFailed: string;
    /** load-more control under the first page of the revision list */
    showMore: (n: number) => string;
  };
  comments: {
    sectionTitle: string;
    count: (n: number) => string;
    placeholder: string;
    inputLabel: string;
    preview: string;
    keepEditing: string;
    post: string;
    posted: string;
    postFailed: string;
    delete: string;
    deleteFailed: string;
    confirmDelete: string;
    rendering: string;
    previewFailed: string;
    signInPrompt: string;
    signIn: string;
    postingAs: (name: string) => string;
  };
  share: {
    title: string;
    chip: string;
    chipReady: string;
    chipUnconfigured: string;
    intro: string;
    visibility: string;
    visPassword: string;
    visPasswordHint: string;
    visLink: string;
    visLinkHint: string;
    visPublic: string;
    visPublicHint: string;
    alias: string;
    aliasHint: string;
    aliasInvalid: string;
    readableBy: (label: string) => string;
    changeVisibility: string;
    apply: string;
    visibilityChanged: string;
    visibilityFailed: string;
    link: string;
    password: string;
    expires: string;
    days7: string;
    days30: string;
    never: string;
    create: string;
    revoke: string;
    revoked: string;
    revokeFailed: string;
    revokeNotAllowed: string;
    copy: string;
    copied: (label: string) => string;
    copyFailed: string;
    created: string;
    passwordMin: string;
    building: string;
    passwordOnce: string;
    savePasswordNow: string;
    neverExpires: string;
    expiresOn: (date: string) => string;
    /** a snapshot step's progress line */
    stage: Record<ShareStage, (progress: ShareProgress) => string>;
    shareFailed: string;
    streamEnded: string;
    loading: string;
    loadFailed: string;
    upToDate: (published: string) => string;
    staleSince: (changed: string) => string;
    followHint: (minutes: number) => string;
    manualOnly: string;
    pinnedHint: (published: string) => string;
    publish: string;
    publishing: string;
    published: string;
    publishFailed: string;
    pin: string;
    unpin: string;
    pinned: string;
    unpinned: string;
    pinFailed: string;
    dotCurrent: string;
    dotStale: string;
    dotPinned: string;
  };
  sync: {
    title: (peer: string) => string;
    loading: string;
    /** the one-line state of a unit on a peer (chip title, popover headline) */
    standing: Record<Standing, (peer: string) => string>;
    /** the same state, short, for a row of the overview */
    rowState: Record<Standing, string>;
    together: (unit: string) => string;
    planSummary: (notes: number, files: number, size: string) => string;
    classification: string;
    degraded: (count: number, peer: string) => string;
    degradedIn: (note: string) => string;
    publish: (peer: string) => string;
    publishAgain: string;
    overwrite: string;
    overwriteConfirm: (peer: string) => string;
    adopt: string;
    adoptConfirm: (peer: string) => string;
    withdraw: string;
    withdrawConfirm: (peer: string) => string;
    withdrawChangedConfirm: (peer: string) => string;
    cancel: string;
    openCopy: string;
    synced: (time: string) => string;
    occupiedExplain: (peer: string) => string;
    foreignExplain: (peer: string) => string;
    behindExplain: (synced: string, changed: string | null) => string;
    changedExplain: string;
    changedBehind: string;
    refusedTitle: string;
    unreachableExplain: (peer: string) => string;
    /** the headline of a pending withdrawal (a pending publish uses `standing.pending`) */
    pendingWithdraw: (peer: string) => string;
    pendingExplain: (time: string) => string;
    rejectedExplain: (peer: string, time: string) => string;
    rejectedWithdraw: (peer: string, time: string) => string;
    problemsFound: string;
    /** why a publish or withdraw did not go through; `detail` is the
     *  server's own line (git's error for 'unreachable') */
    error: Record<SyndicationErrorCode, (peer: string, detail: string) => string>;
    /** a publish's progress line; `seconds` waited so far on the peer's checks */
    stage: Record<SyndicationStage, (peer: string, seconds: number | undefined) => string>;
    warning: Record<SyndicationWarning['kind'], (url: string, note: string, peer: string) => string>;
    refusal: {
      never: (note: string) => string;
      copy: (note: string) => string;
      frontmatter: (note: string, detail: string) => string;
      'no-root': (note: string) => string;
      'no-frontmatter': (note: string) => string;
      degrade: (note: string, target: string) => string;
    };
    /** a running operation's line before its first progress */
    starting: Record<Action, string>;
    /** how an operation ended, for its toast */
    outcome: Record<Action, Record<Outcome, (peer: string) => string>>;
    /** the latest attempt's failure: when, and why */
    attemptFailed: Record<Action, (time: string, reason: string) => string>;
    stillOpen: (peer: string) => string;
    /** this page's attempt whose ending has not shown: what is being checked */
    unsettledExplain: Record<'publish' | 'withdraw', (peer: string) => string>;
    queued: string;
    dequeue: string;
    rowQueued: string;
    problemsCount: (count: number) => string;
    overrides: {
      fold: string;
      hint: (peer: string) => string;
      label: string;
      save: string;
      notMap: string;
      invalid: (message: string) => string;
      loadFailed: string;
    };
    overview: {
      link: (count: number | null) => string;
      title: (peer: string) => string;
      back: string;
      empty: string;
      missing: string;
      publish: string;
      publishAll: (count: number) => string;
      /** the overview's live line: the unit running and where it is */
      progress: (title: string, line: string) => string;
      done: (accepted: number, pending: number, failed: number) => string;
      loadFailed: string;
    };
    copy: {
      chip: (wiki: string) => string;
      notice: (wiki: string) => string;
      revision: string;
    };
  };
}

/** a login error code's message, from a table keyed by the known codes */
function loginErrorOf(table: Record<LoginErrorCode, string>, code: string): string | undefined {
  return Object.hasOwn(table, code) ? table[code as LoginErrorCode] : undefined;
}

const EN_LOGIN_ERRORS: Record<LoginErrorCode, string> = {
  saml_config: 'SSO is not configured correctly on this site.',
  saml_disabled: 'SSO sign-in is disabled on this site.',
  saml_response: 'The SSO response was missing or unreadable.',
  saml_invalid: 'The SSO response could not be verified.',
  saml_error: 'SSO sign-in failed.',
  google_state: 'The Google sign-in expired or was started in another browser — sign in again.',
  google_error: 'Google sign-in failed.',
  wrong_domain: 'Your account is not in an allowed email domain.',
  not_member: 'Your account is not a member of this site.',
  member_conflict: 'This address is listed as another member’s commit address. Ask an admin to sort it out in Members.',
};

const en: Strings = {
  common: {
    requestFailed: 'Request failed',
    tool: (label) => label,
    http: (status) =>
      status === 0
        ? "Lost the connection to this wiki's server — check the network and try again."
        : status === 401
          ? 'Your sign-in has expired — sign in again.'
          : status === 403
            ? "You don't have permission to do this."
            : status === 404
              ? 'Not found — the note may have been moved or deleted.'
              : status === 413
                ? 'The request is too large for this server.'
                : status >= 500
                  ? `This wiki's server ran into an error (HTTP ${status}).`
                  : `The request failed (HTTP ${status}).`,
  },
  errors: ENGLISH_ERRORS,
  auth: {
    chipLabel: 'Account',
    accountPanel: 'Account',
    signIn: 'Sign in',
    panelTitle: 'Sign in',
    googleButton: 'Sign in with Google Workspace',
    samlButton: 'Sign in with Google Workspace SSO',
    notConfigured: 'Not configured',
    googleMissingEnv:
      'Enabled, but the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are missing (see the docs)',
    samlMissingConfig:
      'Enabled, but the SSO URL / IdP entity id / certificate / baseUrl config is incomplete (see the docs)',
    devLoginLabel: 'Local test sign-in',
    nickname: 'Nickname',
    emailPlaceholder: 'you@team.com',
    enter: 'Enter',
    or: 'or',
    signOut: 'Sign out',
    signedIn: (name) => `Signed in as ${name}`,
    signedOut: 'Signed out',
    signInFailed: 'Sign-in failed',
    loginError: (code) => loginErrorOf(EN_LOGIN_ERRORS, code) ?? `Sign-in failed (${code})`,
    provider: {
      dev: 'Local test session',
      google: 'Google Workspace',
      'google-saml': 'Google Workspace SSO',
    },
    noProviders: 'No sign-in method enabled (configure inkbrush.config.ts → auth)',
    role: (role) => `Role: ${role ?? '—'}`,
    members: 'Members',
    rename: 'Change your name',
    nameField: 'Your name',
    renamedSelf: (name) => `You are now ${name}`,
  },
  identity: {
    title: 'Members',
    count: (n) => (n === 1 ? '1 person' : `${n} people`),
    lede: 'A name shows in bylines, mentions, comments and the revision history. Commit addresses make the commits that carry them count as that person’s.',
    searchPlaceholder: 'Find by name or address',
    close: 'Close',
    noMatch: (q) => `Nobody matches “${q}”.`,
    nameLabel: (email) => `Name of ${email}`,
    renamed: (name) => `Renamed to ${name}`,
    you: 'You',
    roleLabel: (name) => `Role of ${name}`,
    aliasesLabel: 'Commit addresses',
    aliasHint: 'Other addresses this person’s git commits carry, such as a personal address',
    aliasPlaceholder: 'name@example.com',
    addAlias: 'Add address',
    addAliasLabel: (name) => `Add a commit address for ${name}`,
    removeAlias: (alias) => `Remove ${alias}`,
    aliasAdded: (alias) => `Added ${alias}`,
    addTitle: 'Add a member',
    colEmail: 'Email',
    colName: 'Name',
    colRole: 'Role',
    namePlaceholder: 'Name',
    emailPlaceholder: 'name@team.com',
    add: 'Add',
    added: (name) => `Added ${name}`,
    remove: 'Remove',
    removeLabel: (name) => `Remove ${name}`,
    confirmRemove: (name) => `Click again to remove ${name}`,
    confirmRemoveShort: 'Remove?',
    removed: (name) => `Removed ${name}`,
    saved: 'Saved',
    saveFailed: 'Save failed',
    loadFailed: 'Failed to load members',
    emailRequired: 'Enter an email address',
    adminNote: (role) => `At least one “${role}” always stays.`,
  },
  blocks: {
    toolbar: 'Block tools',
    focusHint: 'Enter opens the block tools · Arrow up/down moves between blocks',
    edit: 'Edit this block (opens the source)',
    ai: 'Ask Claude to edit this block',
    history: 'Revision history / revert',
    signInFirst: 'Sign in to edit',
    editorLoadFailed: 'Editor failed to load — refresh the page and retry',
    aiLoadFailed: 'AI panel failed to load — refresh the page and retry',
    historyLoadFailed: 'History panel failed to load — refresh the page and retry',
  },
  editor: {
    title: (jsx) => (jsx ? `Edit · ${jsx} component block` : 'Edit · Markdown block'),
    frontmatterTitle: 'Edit · frontmatter (YAML)',
    shortcutHint: '⌘/Ctrl + Enter to save · Esc to cancel',
    placeholder: 'MDX source…',
    frontmatterPlaceholder: 'YAML frontmatter…',
    save: 'Save',
    cancel: 'Cancel',
    validating: 'Validating…',
    savedReloading: 'Saved · reloading…',
    saved: 'Saved',
    saveFailed: 'Save failed',
    readFailed: 'Failed to read the block source',
    empty: '(empty)',
    previewFailed: 'Preview failed',
    jsxNoPreview: (name) =>
      `⟨${name ?? 'component'}⟩ component blocks have no standalone preview — the page hot-reloads right after save`,
    frontmatterNoPreview:
      'Frontmatter has no preview — title, description and the rest of the page head re-render from it right after save',
  },
  ai: {
    title: (start, end) => `Claude · edit block L${start}–${end}`,
    placeholder: (jsx) =>
      `Tell Claude what to change in this ${jsx ? `⟨${jsx}⟩ ` : ''}block…`,
    inputLabel: 'Instruction for Claude',
    run: 'Ask Claude to edit',
    working: 'Claude is editing…',
    done: 'Claude finished editing — reloading…',
    jobFailed: 'Job failed',
    unchanged: 'nothing was changed',
    streamEnded: 'The connection ended before the job finished — try again',
    quick: [
      {
        label: 'Polish',
        instruction:
          'Polish the prose of this block: smoother and more precise, without changing the technical content or the overall length.',
      },
      {
        label: 'More rigorous',
        instruction:
          'Make this block more rigorous: add the necessary qualifiers and fix imprecise claims (keep the existing writing style).',
      },
      {
        label: 'Condense',
        instruction:
          'Condense this block to roughly two thirds of its length: cut redundancy, keep every key point and formula.',
      },
      {
        label: 'Fix formulas',
        instruction:
          'Check the math in this block (notation consistency, sub/superscripts, dimensions) and fix any problems; if nothing is wrong, change nothing.',
      },
    ],
  },
  chat: {
    title: 'Claude · note assistant',
    dialogLabel: 'Claude assistant',
    fabTitle: 'Ask Claude / AI actions',
    inputPlaceholder: 'Ask Claude about this note… (Enter to send)',
    inputLabel: 'Message to Claude',
    send: 'Send',
    newChat: 'New conversation',
    collapse: 'Collapse',
    thinking: 'Claude is thinking…',
    emptyHint: 'Ask about this note; Claude reads the source file directly on the server.',
    newChatStarted: 'Started a new conversation',
    signInFirst: 'Sign in first',
    translateConfirm: (label) =>
      `Generate the ${label} version with Claude?\nThe whole note is re-told in the target language (structure and formulas preserved) and any demo language tables are updated. This takes a few minutes.`,
    translateAction: (label) => `✦ Generate the ${label} version (full re-telling translation)`,
    translateDone: 'Translation finished — reloading…',
    streamEnded: 'The connection ended before the reply finished — try again',
    notice: {
      'no-change': 'No change was needed.',
      'commit-failed': 'Saved, but the git commit failed — check the server log.',
    },
  },
  history: {
    via: {
      manual: 'Manual edit',
      claude: 'Claude edit',
      translate: 'AI translation',
      inbox: 'Inbox import',
      revert: 'Revert',
    },
    title: (start, end) => `Block history · L${start}-${end}`,
    wholeFile: 'Whole file',
    wholeFileNote: 'Whole-file operation — undoing it is a git operation, not a one-click revert',
    viewDiff: 'View changes',
    revert: '⟲ Revert this change',
    revertTitle: 'Restore the content from before this change',
    reverted: 'Reverted — reloading…',
    revertFailed: 'Revert failed',
    signInToRevert: 'Sign in to revert',
    noRecords: 'No revisions recorded for this block yet',
    loadFailed: 'Failed to load revision history',
    showMore: (n) => (n === 1 ? 'Show 1 older revision' : `Show ${n} older revisions`),
  },
  comments: {
    sectionTitle: 'Comments',
    count: (n) => (n === 0 ? 'No comments yet' : n === 1 ? '1 comment' : `${n} comments`),
    placeholder: 'Write a comment… markdown and $…$ math supported',
    inputLabel: 'Comment',
    preview: 'Preview',
    keepEditing: 'Keep editing',
    post: 'Post',
    posted: 'Posted',
    postFailed: 'Post failed',
    delete: 'Delete',
    deleteFailed: 'Delete failed',
    confirmDelete: 'Delete this comment?',
    rendering: 'Rendering…',
    previewFailed: 'Preview failed',
    signInPrompt: 'Sign in to join the discussion — ',
    signIn: 'Sign in',
    postingAs: (name) => `Posting as ${name} · markdown / $math$ / code blocks`,
  },
  share: {
    title: 'Share',
    chip: 'Share',
    chipReady: 'Share this note',
    chipUnconfigured:
      'Share is enabled, but gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN is missing',
    intro: 'Publish a static snapshot of this note — for the holders of a password, for anyone with the link, or for everyone.',
    visibility: 'Who can read',
    visPassword: 'With the password',
    visPasswordHint: 'The link and a password; the password is shown once.',
    visLink: 'Anyone with the link',
    visLinkHint: 'The unguessable link is the key; search engines are asked to stay away.',
    visPublic: 'Everyone',
    visPublicHint: 'Open to all and to search engines, at a readable address.',
    alias: 'Address',
    aliasHint: 'Lowercase letters, digits and hyphens; leave empty to use the id.',
    aliasInvalid: 'Address: lowercase letters, digits and inner hyphens, up to 64 characters',
    readableBy: (label) => `Readable by: ${label}`,
    changeVisibility: 'Change who can read',
    apply: 'Apply',
    visibilityChanged: 'Share updated',
    visibilityFailed: 'Could not change the share',
    link: 'Link',
    password: 'Password',
    expires: 'Expires',
    days7: '7 days',
    days30: '30 days',
    never: 'Never',
    create: 'Create share',
    revoke: 'Revoke',
    revoked: 'Share revoked',
    revokeFailed: 'Revoke failed',
    revokeNotAllowed: 'Only the creator of this link (or an admin) can revoke it',
    copy: 'Copy',
    copied: (label) => `${label} copied`,
    copyFailed: 'Copy failed — select and copy manually',
    created: 'Share created',
    passwordMin: 'Password must be at least 6 characters',
    building: 'Building snapshot… may take a minute on first share',
    passwordOnce: 'Password was shown at creation only (not stored)',
    savePasswordNow: 'Save the password now — it will not be shown again.',
    neverExpires: 'Never expires',
    expiresOn: (date) => `Expires ${date}`,
    stage: {
      'build-cached': () => 'Using the cached static build',
      build: () => 'Building the static site — may take a few minutes on first share…',
      rebuild: () => 'The build inputs changed during the build — rebuilding once…',
      building: ({ seconds }) => `Building the static site… ${seconds ?? 0} s`,
      built: () => 'Static build finished',
      collecting: () => "Collecting the page's assets…",
      'snapshot-ready': ({ count }) => `Snapshot ready (${count ?? 0} assets)`,
      packing: ({ count }) => `Packing the snapshot (${count ?? 0} files)…`,
      unchanged: () => 'The published snapshot already matches — nothing to upload',
      uploading: () => 'Uploading to the share gateway…',
      updating: () => 'Updating the share gateway…',
    },
    shareFailed: 'Share failed',
    streamEnded: 'Stream ended without a result',
    loading: 'Loading…',
    loadFailed: 'Failed to load shares',
    upToDate: (published) => `The published version is current (${published}).`,
    staleSince: (changed) => `The note changed ${changed} — the link still shows the previous version.`,
    followHint: (minutes) => `It publishes on its own once the note has been quiet for ${minutes} min.`,
    manualOnly: 'This site publishes by hand only.',
    pinnedHint: (published) => `Pinned to the version of ${published} — it never updates on its own.`,
    publish: 'Publish this version',
    publishing: 'Publishing…',
    published: 'Share updated',
    publishFailed: 'Publish failed',
    pin: 'Pin this version',
    unpin: 'Unpin — follow the note',
    pinned: 'Pinned — the link keeps this version',
    unpinned: 'Following the note again',
    pinFailed: 'Could not change the pin',
    dotCurrent: 'Shared · the link is current',
    dotStale: 'Shared · unpublished changes',
    dotPinned: 'Shared · pinned to a version',
  },
  sync: {
    title: (peer) => `Sync to ${peer}`,
    loading: 'Loading…',
    standing: {
      absent: (peer) => `Not on ${peer} yet`,
      current: (peer) => `Synced to ${peer} · up to date`,
      behind: (peer) => `Synced to ${peer} · this note changed since`,
      changed: (peer) => `Someone changed the copy on ${peer}`,
      occupied: (peer) => `${peer} has a note of its own at this address`,
      foreign: (peer) => `${peer} holds another wiki's copy at this address`,
      pending: (peer) => `Submitted · ${peer} is checking it`,
      rejected: (peer) => `Returned by ${peer}`,
      refused: () => "This note can't be synced",
      unreachable: (peer) => `Can't reach ${peer}`,
      unsettled: (peer) => `Checking how it went on ${peer}`,
    },
    rowState: {
      absent: 'not synced',
      current: 'up to date',
      behind: 'changed here',
      changed: 'changed there',
      occupied: 'address taken',
      foreign: 'address taken',
      pending: 'being checked',
      rejected: 'returned',
      refused: "can't sync",
      unreachable: 'unreachable',
      unsettled: 'checking how it went',
    },
    together: (unit) => `Synced together with ${unit}`,
    planSummary: (notes, files, size) =>
      `${notes === 1 ? '1 note' : `${notes} notes`}, ${files === 1 ? '1 file' : `${files} files`} (${size}) will be published`,
    classification: 'In the copy',
    degraded: (count, peer) =>
      `${count === 1 ? '1 link points' : `${count} links point`} to notes ${peer} doesn't have — plain text in the copy`,
    degradedIn: (note) => `in ${note}`,
    publish: (peer) => `Publish to ${peer}`,
    publishAgain: 'Publish this version',
    overwrite: 'Publish and overwrite',
    overwriteConfirm: (peer) => `The changes made on ${peer} will be lost.`,
    adopt: 'Replace it with this note',
    adoptConfirm: (peer) => `${peer}'s own note is replaced by this one; its old text stays in ${peer}'s git history.`,
    withdraw: 'Withdraw',
    withdrawConfirm: (peer) => `Remove the copy from ${peer}?`,
    withdrawChangedConfirm: (peer) => `Remove the copy from ${peer}, the changes made there included?`,
    cancel: 'Cancel',
    openCopy: 'Open copy ↗',
    synced: (time) => `Synced ${time}`,
    occupiedExplain: (peer) =>
      `${peer} already has a note of its own at this address. Publishing replaces it with a copy of this note.`,
    foreignExplain: (peer) =>
      `${peer} holds a copy synced from another wiki at this address, so this note can't go there. Move one of the two notes to another address, or have the other wiki withdraw its copy.`,
    behindExplain: (synced, changed) =>
      changed
        ? `This note changed after the synced version (synced ${synced}, last changed ${changed}).`
        : `This note changed after the synced version (synced ${synced}).`,
    changedExplain: 'Publishing again overwrites the edits made there.',
    changedBehind: 'This note has changed as well.',
    refusedTitle: "Why it can't be synced",
    unreachableExplain: (peer) => `Reaching ${peer}'s repository failed:`,
    pendingWithdraw: (peer) => `Withdrawal submitted · ${peer} is checking it`,
    pendingExplain: (time) => `This usually takes a minute or two (submitted ${time}).`,
    rejectedExplain: (peer, time) => `${peer}'s checks refused the submission (${time}). Fix what they found, then publish again.`,
    rejectedWithdraw: (peer, time) => `${peer}'s checks refused the withdrawal (${time}).`,
    problemsFound: 'What the checks found',
    error: {
      foreign: (peer) => `${peer} now holds another wiki's copy at this address.`,
      native: (peer) => `${peer} has a note of its own at this address — replacing it takes an explicit choice.`,
      gone: (peer) => `The copy was removed from ${peer} meanwhile — publish again to recreate it.`,
      moved: (peer) => `The copy on ${peer} changed a moment ago — check its state and try again.`,
      changed: (peer) => `Someone edited the copy on ${peer} — overwriting it takes an explicit choice.`,
      'digest-mismatch': () => 'The two wikis compute revisions differently — run the same engine version on both.',
      invalid: () => "Not submitted — the copy doesn't pass this wiki's checks.",
      refused: () => "This note can't be synced.",
      busy: () => 'This note is being published or withdrawn right now — wait for it to finish.',
      pending: (peer) => `${peer} is still checking the last submission — wait for its answer.`,
      rejected: (peer) => `Returned by ${peer} — its checks refused the copy.`,
      unreachable: (peer, detail) => `Can't reach ${peer}: ${detail}`,
    },
    stage: {
      fetching: (peer) => `Reading ${peer}'s repository…`,
      preparing: () => 'Preparing the copy…',
      checking: () => "Checking the copy with this wiki's checks…",
      submitting: (peer) => `Submitting to ${peer}…`,
      waiting: (peer, seconds) =>
        seconds === undefined
          ? `Submitted — waiting for ${peer}'s checks…`
          : `Submitted — waiting for ${peer}'s checks… (${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`})`,
    },
    warning: {
      image: (url, note, peer) => `The image ${url} in ${note} lives in a note ${peer} doesn't have — it won't show in the copy.`,
      element: (url, note, peer) => `The link ${url} in ${note} points to a note ${peer} doesn't have — it will be broken in the copy.`,
    },
    refusal: {
      never: (note) => `${note} says syndication: false — it is never synced anywhere.`,
      copy: (note) => `${note} is itself a copy synced from another wiki.`,
      frontmatter: (note, detail) => `The frontmatter of ${note} doesn't parse (${detail}).`,
      'no-root': (note) => `${note} has no root note in the default language.`,
      'no-frontmatter': (note) => `${note} has no frontmatter block — a copy needs one.`,
      degrade: (note, target) =>
        `In ${note}, the link to ${target} cannot become plain text without changing what the text around it means — rewrite that sentence or link differently.`,
    },
    starting: { publish: 'Submitting…', withdraw: 'Withdrawing…', overrides: 'Saving…' },
    outcome: {
      publish: {
        accepted: (peer) => `Synced to ${peer}`,
        pending: (peer) => `Submitted — ${peer} is still checking it`,
        rejected: (peer) => `Returned by ${peer} — its checks refused the copy`,
        failed: (peer) => `The publish to ${peer} didn't go through`,
        unknown: (peer) => `Submitted, but ${peer} couldn't be read afterwards — its answer shows once it can be reached`,
      },
      withdraw: {
        accepted: (peer) => `Withdrawn from ${peer}`,
        pending: (peer) => `Withdrawal submitted — ${peer} is checking it`,
        rejected: (peer) => `${peer}'s checks refused the withdrawal`,
        failed: (peer) => `The withdrawal from ${peer} didn't go through`,
        unknown: (peer) => `Withdrawal submitted, but ${peer} couldn't be read afterwards — its answer shows once it can be reached`,
      },
      overrides: {
        accepted: () => 'Saved — the next publish carries it',
        pending: () => 'Saved — the next publish carries it',
        rejected: () => 'Saved — the next publish carries it',
        failed: () => "Saving didn't go through",
        unknown: () => 'Saved — the next publish carries it',
      },
    },
    attemptFailed: {
      publish: (time, reason) => `Publishing at ${time} didn't go through: ${reason}`,
      withdraw: (time, reason) => `Withdrawing at ${time} didn't go through: ${reason}`,
      overrides: (time, reason) => `Saving at ${time} didn't go through: ${reason}`,
    },
    stillOpen: (peer) => `A submission to ${peer} is still waiting on its checks; this keeps asking.`,
    unsettledExplain: {
      publish: (peer) =>
        `The answer to the last publish went missing. This keeps asking ${peer} until it shows whether the copy went in; until then nothing else can be sent.`,
      withdraw: (peer) =>
        `The answer to the last withdrawal went missing. This keeps asking ${peer} until it shows whether the copy was removed; until then nothing else can be sent.`,
    },
    queued: 'Queued — it publishes after the notes ahead of it.',
    dequeue: 'Take out of the queue',
    rowQueued: 'queued',
    problemsCount: (count) => `What the checks found (${count})`,
    overrides: {
      fold: "Change the copy's classification",
      hint: (peer) =>
        `Fields written here replace the note's own values in the copy on ${peer}; null drops a field. Leave it empty to keep the note's values.`,
      label: 'Overrides (YAML)',
      save: 'Save',
      notMap: 'Write one "field: value" per line',
      invalid: (message) => `Not valid YAML: ${message}`,
      loadFailed: 'Could not load the YAML editor',
    },
    overview: {
      link: (count) => (count === null ? 'All synced notes' : `All synced notes (${count})`),
      title: (peer) => `Notes synced to ${peer}`,
      back: '← This note',
      empty: 'Nothing synced yet',
      missing: 'gone here',
      publish: 'Publish',
      publishAll: (count) => `Publish all behind (${count})`,
      progress: (title, line) => `${title}: ${line}`,
      done: (accepted, pending, failed) =>
        [
          `${accepted} synced`,
          pending ? `${pending} still being checked` : '',
          failed ? `${failed} not synced` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      loadFailed: 'Could not load the synced notes',
    },
    copy: {
      chip: (wiki) => `Copy · from ${wiki}`,
      notice: (wiki) =>
        `This note is a copy synced from ${wiki}. Edit it there — changes made here would be overwritten by the next sync.`,
      revision: 'Revision',
    },
  },
};

const ZH_SHARE_ACTION: Record<ShareAction, string> = { publish: '发布', change: '修改', pin: '钉住', revoke: '撤销' };
const ZH_VISIBILITY: Record<string, string> = { password: '凭密码', link: '有链接就能看', public: '完全公开' };

const ZH_ERRORS: ErrorTable = {
  'bad-request': ({ detail }) => `请求格式不对（${detail}）`,
  'bad-path': ({ segment }) => `地址里有一段编码不对：${segment}`,
  'not-json': () => '请求内容要按 application/json 发送',
  'bad-json': () => '请求内容不是合法的 JSON',
  'body-too-large': ({ limit }) => `请求内容太大（上限 ${limit} 字节）`,
  'cross-site': () => '拒绝了来自别的网站的请求',
  'sign-in-required': () => '请先登录',
  'admin-only': () => '只有管理员能做这件事',
  'not-member': () => '你不是本站成员',
  unexpected: ({ detail }) => `出错了：${detail}`,
  internal: ({ id }) => `服务器内部出错（编号 ${id}）`,

  'dev-login-off': () => '本地测试登录没有开启（inkbrush.config.ts → auth.dev；没写 dev: true 时只接受本机访问）',
  'dev-login-fields': () => '需要填写昵称和有效的邮箱',
  'google-off': () => '本站没有开启 Google 登录（inkbrush.config.ts → auth.google）',
  'google-unconfigured': () => 'Google 登录已开启，但环境变量里缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
  'google-base-url': () => '不在 localhost 上时，Google 登录需要配置 auth.google.baseUrl（inkbrush.config.ts）',
  'saml-off': () => '本站没有开启 SAML 登录（inkbrush.config.ts → auth.googleSaml）',
  'saml-unconfigured': () => 'SAML 登录已开启，但配置不完整（entryPoint / idpEntityId / certFile / baseUrl）',

  'members-email': ({ email }) => `邮箱无效：「${email}」`,
  'members-duplicate': ({ email }) => `邮箱重复：${email}`,
  'members-role': ({ role, roles }) => `未知角色「${role}」（可选：${roles.join('、')}）`,
  'members-admin': ({ role }) => `至少要保留一名「${role}」`,
  'members-name': ({ email, max }) => `${email} 的名字要写在一行里，1 到 ${max} 个字，不能含 < 或 >`,
  'members-alias': ({ email, alias }) => `${email} 的其他邮箱「${alias}」不是邮箱地址`,
  'members-alias-taken': ({ alias, owner }) => `${alias} 已经属于 ${owner}`,
  'members-stale': () => '成员表刚被别人改过，已经刷新，请再改一次',

  'note-not-found': () => '找不到这篇笔记',
  'note-ambiguous': ({ id }) => `笔记「${id}」同时有 index.md 和 index.mdx，请删掉其中一个`,
  copy: ({ wiki }) => `这篇是从 ${wiki} 同步来的副本，请到那边修改`,
  'line-range': () => '行号范围超出了文件',
  'block-changed': () => '这个块已经被别人改过了，请刷新后重试',
  'save-would-not-build': ({ detail }) => `改完后页面无法构建，没有保存：${detail}`,
  'revision-not-found': () => '找不到这条修订记录',
  'revert-whole-file': () => '整篇级操作不能一键回滚',
  'revert-no-change': () => '这条修订没有内容改动',
  'revert-overwritten': () => '后来的修改已经覆盖了这次修订，请手动回滚',
  'revert-ambiguous': () => '要回滚的内容在文中出现了不止一次，请手动回滚',

  'comment-empty': () => '评论不能为空',
  'comment-too-long': ({ max }) => `评论太长（超过 ${max} 个字符）`,
  'comment-not-found': () => '找不到这条评论',
  'comment-not-yours': () => '只能删除自己的评论',

  'ai-busy-user': ({ max }) => `你已经有 ${max} 个 AI 任务在运行，等其中一个完成再试`,
  'ai-busy-machine': ({ max }) => `服务器上已经在运行 ${max} 个 AI 任务，等其中一个完成再试`,
  'chat-session': () => '找不到这段对话（服务器重启后对话会清空），请开启新对话',
  'job-setup': ({ detail }) => `任务准备失败：${detail}`,
  'job-range-gone': () => '选中的行已经不存在了（排队期间笔记被改过），请刷新后重试',
  'translate-same': () => '目标语言和当前语言相同',
  'translate-unsupported': ({ lang }) => `不支持的目标语言：${lang}`,
  'translate-exists': ({ id }) => `这个语言版本已经存在：${id}`,
  'translate-target': ({ id }) => `目标笔记的 id 无效：${id}`,
  'claude-unavailable': ({ detail }) => `无法启动 claude 命令行：${detail}（用 WIKI_CLAUDE_BIN 指定它的位置）`,
  'job-timeout': ({ seconds }) => `任务超时（${seconds} 秒），已被终止`,
  'client-disconnected': () => '浏览器断开了连接',
  'job-error': ({ detail }) => `AI 任务失败${detail ? `：${detail}` : ''}`,
  'job-output-overflow': ({ megabytes }) => `claude 输出的一行超过了 ${megabytes} MB 还没结束，任务已被终止`,
  'job-exited': ({ exitCode, detail, ignoredLines }) =>
    `claude 意外退出（退出码 ${exitCode}）${detail ? `：${detail}` : ''}${
      ignoredLines > 0 ? `（有 ${ignoredLines} 行输出不是 JSON，已忽略）` : ''
    }`,
  'job-deleted-note': ({ file }) => `任务删掉了笔记文件本身（${file}）`,
  'job-no-baseline': ({ file }) => `笔记文件（${file}）没有可供修改的原始版本`,
  'job-outside-block': ({ file, start, end }) => `任务改动了 ${file} 里选中块（L${start}-${end}）以外的行`,
  'job-touched-source': ({ file }) => `任务改动了原文笔记（${file}）`,
  'job-stray-file': ({ file }) => `任务改动了目标以外的文件（${file}）`,
  'job-no-target': ({ file }) => `任务没有生成目标文件（${file}）`,
  'job-would-not-build': ({ detail }) => `改完后页面无法构建：${detail}`,
  'job-conflict': ({ file }) => `任务运行期间「${file}」被改过了`,

  'share-off': () => '本站没有配置分享（inkbrush.config.ts → share）',
  'share-unconfigured': () => '分享已启用，但配置不完整（缺 gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN）',
  'share-exists': () => '这篇已经有一个有效的分享链接，请先撤销它',
  'share-creating': () => '这篇的分享正在创建，请等它完成',
  'share-busy': () => '这个分享正在发布，请等它完成',
  'share-not-found': () => '找不到这个分享',
  'share-not-yours': ({ action }) => `只有分享的创建者（或管理员）能${ZH_SHARE_ACTION[action]}它`,
  'share-password-short': () => '密码至少 6 个字符',
  'share-password-unexpected': ({ visibility }) => `「${ZH_VISIBILITY[visibility] ?? visibility}」的分享不设密码`,
  'share-alias-not-public': () => '只有完全公开的分享才能设置地址',
  'share-alias-invalid': () => '地址只能是小写字母、数字和中间的连字符，最多 64 个字符',
  'share-unpin-first': () => '请先解除钉住：改成完全公开会把笔记的当前版本发布出去',
  'share-revoked-meanwhile': () => '分享在修改过程中被撤销了',
  'gateway-token': () => '分享网关拒绝了 SHARE_GATEWAY_TOKEN',
  'gateway-status': ({ status, detail }) => `分享网关出错（HTTP ${status}）${detail ? `：${detail}` : ''}`,
  'gateway-unreachable': ({ url, detail }) => `分享网关不可达（${url}）：${detail}`,
  'gateway-refused': ({ detail }) => `分享网关拒绝了：${detail}`,
  'gateway-lost': () => '分享网关上已经没有这个分享了，请撤销后重新分享',
  'gateway-unknown-share': () => '分享网关上没有这个分享，或者网关版本太旧、还不支持可见范围',
  'gateway-outdated': () => '分享网关还不支持「有链接就能看」和「完全公开」，请升级网关，或改用密码分享',
  'snapshot-unstable': () => '构建快照期间站点一直在改动，等改动停下来再试',
  'snapshot-too-large': ({ size, limit }) => `快照有 ${size} MiB，超过了 ${limit} MiB 的上限`,
  'build-missing': ({ path }) => `找不到 astro 程序（${path}），请先安装站点的依赖`,
  'build-start': ({ detail }) => `无法启动 astro 构建：${detail}`,
  'build-timeout': ({ minutes }) => `astro 构建超时（${minutes} 分钟），已被终止`,
  'build-failed': ({ exitCode, detail }) => `astro 构建失败（退出码 ${exitCode}）${detail ? `：…${detail}` : ''}`,

  'syndication-off': () => '本站没有配置同步（inkbrush.config.ts → syndication）',
  'peer-unknown': ({ peer }) => `没有这个同步对象：${peer}`,
  'unit-unknown': ({ unit }) => `本站没有「${unit}」这一篇`,
  'overrides-no-frontmatter': () => '这篇笔记没有可读的 frontmatter',
  'overrides-never': () => '这篇写了 syndication: false，请先去掉',

  'inbox-off': () => '本站没有开启收件箱（inkbrush.config.ts → inbox.dir）',
  'inbox-missing': ({ path }) => `文件不存在：${path}`,

  'storage-unavailable': () => '浏览器的本地存储不可用，这次修改保存不下来',
  'playground-unavailable': () => 'playground 里没有这个功能',
};

const ZH_TOOL_VERBS: Record<string, string> = {
  Read: '读取',
  Edit: '编辑',
  MultiEdit: '批量编辑',
  Write: '写入',
  NotebookEdit: '编辑笔记本',
  Grep: '检索',
  Glob: '列文件',
  Bash: '命令',
  WebSearch: '搜索网页',
  WebFetch: '抓取网页',
  TodoWrite: '更新待办',
  Task: '子任务',
  Agent: '子任务',
};

const ZH_LOGIN_ERRORS: Record<LoginErrorCode, string> = {
  saml_config: '本站的 SSO 配置不正确。',
  saml_disabled: '本站未启用 SSO 登录。',
  saml_response: 'SSO 响应缺失或无法读取。',
  saml_invalid: 'SSO 响应无法通过校验。',
  saml_error: 'SSO 登录失败。',
  google_state: 'Google 登录已过期，或不是在这个浏览器里发起的，请重新登录。',
  google_error: 'Google 登录失败。',
  wrong_domain: '你的账号不在允许的邮箱域名内。',
  not_member: '你的账号不是本站成员。',
  member_conflict: '这个邮箱登记在另一位成员的提交邮箱里，请管理员在「成员」里处理。',
};

const zh: Strings = {
  common: {
    requestFailed: '请求失败',
    tool: (label) => translateTool(label, ZH_TOOL_VERBS),
    http: (status) =>
      status === 0
        ? '和本站服务器的连接断了，检查网络后再试。'
        : status === 401
          ? '登录已过期，请重新登录。'
          : status === 403
            ? '你没有权限做这件事。'
            : status === 404
              ? '找不到这篇笔记，可能已被移动或删除。'
              : status === 413
                ? '请求太大，本站服务器不接收。'
                : status >= 500
                  ? `本站服务器出错了（HTTP ${status}）。`
                  : `请求失败（HTTP ${status}）。`,
  },
  errors: ZH_ERRORS,
  auth: {
    chipLabel: '账号',
    accountPanel: '账号',
    signIn: '登录',
    panelTitle: '登录',
    googleButton: '使用 Google Workspace 登录',
    samlButton: '使用 Google Workspace SSO 登录',
    notConfigured: '未配置',
    googleMissingEnv: '已启用但缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 环境变量（见文档）',
    samlMissingConfig: '已启用但配置不完整（缺 SSO URL / IdP entity id / 证书 / baseUrl，见文档）',
    devLoginLabel: '本地测试登录',
    nickname: '昵称',
    emailPlaceholder: 'you@team.com',
    enter: '进入',
    or: '或',
    signOut: '退出登录',
    signedIn: (name) => `已登录：${name}`,
    signedOut: '已退出登录',
    signInFailed: '登录失败',
    loginError: (code) => loginErrorOf(ZH_LOGIN_ERRORS, code) ?? `登录失败（${code}）`,
    provider: {
      dev: '本地测试会话',
      google: 'Google Workspace',
      'google-saml': 'Google Workspace SSO',
    },
    noProviders: '未启用任何登录方式（配置 inkbrush.config.ts → auth）',
    role: (role) => `角色：${role ?? '—'}`,
    members: '成员管理',
    rename: '修改你的名字',
    nameField: '你的名字',
    renamedSelf: (name) => `名字已改为 ${name}`,
  },
  identity: {
    title: '成员',
    count: (n) => `${n} 人`,
    lede: '名字会显示在笔记署名、@提及、评论和修订记录里。提交邮箱：git 提交带着这些邮箱时，算作这个人的提交。',
    searchPlaceholder: '按名字或邮箱查找',
    close: '关闭',
    noMatch: (q) => `没有人对得上「${q}」。`,
    nameLabel: (email) => `${email} 的名字`,
    renamed: (name) => `已改名为 ${name}`,
    you: '你',
    roleLabel: (name) => `${name} 的角色`,
    aliasesLabel: '提交邮箱',
    aliasHint: '这个人的 git 提交用过的其他邮箱，比如个人邮箱',
    aliasPlaceholder: 'name@example.com',
    addAlias: '添加邮箱',
    addAliasLabel: (name) => `给 ${name} 添加提交邮箱`,
    removeAlias: (alias) => `移除 ${alias}`,
    aliasAdded: (alias) => `已添加 ${alias}`,
    addTitle: '添加成员',
    colEmail: '邮箱',
    colName: '名字',
    colRole: '角色',
    namePlaceholder: '名字',
    emailPlaceholder: 'name@team.com',
    add: '添加',
    added: (name) => `已添加 ${name}`,
    remove: '移除',
    removeLabel: (name) => `移除 ${name}`,
    confirmRemove: (name) => `再点一次，移除 ${name}`,
    confirmRemoveShort: '确认移除？',
    removed: (name) => `已移除 ${name}`,
    saved: '已保存',
    saveFailed: '保存失败',
    loadFailed: '成员列表加载失败',
    emailRequired: '请填写邮箱地址',
    adminNote: (role) => `至少保留一名「${role}」。`,
  },
  blocks: {
    toolbar: '块工具',
    focusHint: '按 Enter 打开块工具，↑/↓ 在块之间移动',
    edit: '编辑此块（点击展开源码）',
    ai: '让 Claude 修改此块',
    history: '本块修订历史 / 回滚',
    signInFirst: '请先登录再编辑',
    editorLoadFailed: '编辑器加载失败，请刷新页面重试',
    aiLoadFailed: 'AI 面板加载失败，请刷新页面重试',
    historyLoadFailed: '历史面板加载失败，请刷新页面重试',
  },
  editor: {
    title: (jsx) => (jsx ? `编辑 · ${jsx} 组件块` : '编辑 · Markdown 块'),
    frontmatterTitle: '编辑 · 页面元信息(frontmatter,YAML)',
    shortcutHint: '⌘/Ctrl + Enter 保存 · Esc 取消',
    placeholder: 'MDX 源码…',
    frontmatterPlaceholder: 'YAML 元信息…',
    save: '保存',
    cancel: '取消',
    validating: '校验中…',
    savedReloading: '已保存 · 刷新中…',
    saved: '已保存',
    saveFailed: '保存失败',
    readFailed: '读取源码失败',
    empty: '（空）',
    previewFailed: '预览失败',
    jsxNoPreview: (name) => `⟨${name ?? '组件'}⟩ 组件块没有独立预览 — 保存后页面即时热更新`,
    frontmatterNoPreview: '页面元信息没有预览 — 标题、描述等页头内容保存后随页面即时重绘',
  },
  ai: {
    title: (start, end) => `Claude · 修改块 L${start}–${end}`,
    placeholder: (jsx) => `对这个${jsx ? `〈${jsx}〉` : ''}块提意见，Claude 会直接改…`,
    inputLabel: '给 Claude 的修改要求',
    run: '让 Claude 修改',
    working: 'Claude 修改中…',
    done: 'Claude 已完成修改，页面即将刷新',
    jobFailed: '任务失败',
    unchanged: '没有改动任何内容',
    streamEnded: '连接在任务完成前中断了，请重试',
    quick: [
      {
        label: '润色文字',
        instruction: '润色这个块的文字表达：更流畅、更准确，但不改变技术内容和篇幅量级。',
      },
      {
        label: '更严谨',
        instruction: '让这个块的表述更严谨：补上必要的限定条件、修正不精确的说法（保持原有行文风格）。',
      },
      {
        label: '精简',
        instruction: '把这个块精简到大约原来的三分之二：删冗余、保留全部关键信息与公式。',
      },
      {
        label: '修正公式',
        instruction:
          '检查这个块里的数学公式（记号一致性、上下标、量纲），修正发现的问题；没有问题就不要改。',
      },
    ],
  },
  chat: {
    title: 'Claude · 站内助手',
    dialogLabel: 'Claude 助手',
    fabTitle: '向 Claude 提问 / AI 操作',
    inputPlaceholder: '就这篇笔记向 Claude 提问… (Enter 发送)',
    inputLabel: '发给 Claude 的消息',
    send: '发送',
    newChat: '新对话',
    collapse: '收起',
    thinking: 'Claude 思考中…',
    emptyHint: '针对本篇笔记提问；Claude 会在服务器上直接阅读源文件作答。',
    newChatStarted: '已开启新对话',
    signInFirst: '请先登录',
    translateConfirm: (label) =>
      `用 Claude 生成${label}版？\n整篇笔记会在目标语言下重述（结构与公式保持不变），并同步更新 demo 的多语言标示，耗时数分钟。`,
    translateAction: (label) => `✦ 生成${label}版（整篇重述式翻译）`,
    translateDone: '翻译完成，页面即将刷新',
    streamEnded: '连接在回复完成前中断了，请重试',
    notice: {
      'no-change': '不需要改动。',
      'commit-failed': '已保存，但 git 提交失败了，请看服务器日志。',
    },
  },
  history: {
    via: {
      manual: '手动编辑',
      claude: 'Claude 改写',
      translate: 'AI 翻译',
      inbox: '收件箱导入',
      revert: '回滚',
    },
    title: (start, end) => `本块修订历史 · L${start}-${end}`,
    wholeFile: '整篇',
    wholeFileNote: '整篇级操作 —— 撤销它要用 git 操作，不提供一键回滚',
    viewDiff: '查看改动',
    revert: '⟲ 回滚此次修改',
    revertTitle: '把这次修改撤销回改动前的内容',
    reverted: '已回滚，页面即将刷新',
    revertFailed: '回滚失败',
    signInToRevert: '请先登录再回滚',
    noRecords: '此块还没有修订记录',
    loadFailed: '加载修订历史失败',
    showMore: (n) => `展开更早的 ${n} 条修订`,
  },
  comments: {
    sectionTitle: '讨论',
    count: (n) => (n === 0 ? '还没有评论' : `${n} 条`),
    placeholder: '写下评论… 支持 markdown 与 $…$ 数学',
    inputLabel: '评论',
    preview: '预览',
    keepEditing: '继续编辑',
    post: '发表',
    posted: '已发表',
    postFailed: '发表失败',
    delete: '删除',
    deleteFailed: '删除失败',
    confirmDelete: '删除这条评论？',
    rendering: '渲染中…',
    previewFailed: '预览失败',
    signInPrompt: '登录后参与讨论 —— ',
    signIn: '登录',
    postingAs: (name) => `以 ${name} 的身份发表 · markdown / $数学$ / 代码块`,
  },
  share: {
    title: '分享',
    chip: '分享',
    chipReady: '分享本篇',
    chipUnconfigured: '已启用但配置不完整（缺 gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN）',
    intro: '把本篇发布为静态快照：凭密码、有链接就能看，或完全公开。',
    visibility: '谁能看',
    visPassword: '凭密码',
    visPasswordHint: '有链接还得有密码；密码只在创建时显示一次。',
    visLink: '有链接就能看',
    visLinkHint: '链接本身就是钥匙，猜不出来；并告诉搜索引擎不要收录。',
    visPublic: '完全公开',
    visPublicHint: '所有人和搜索引擎都能看，有一个可读的地址。',
    alias: '地址',
    aliasHint: '小写字母、数字和连字符；留空则用随机 id。',
    aliasInvalid: '地址只能是小写字母、数字和中间的连字符，最多 64 个字符',
    readableBy: (label) => `可见范围：${label}`,
    changeVisibility: '改谁能看',
    apply: '应用',
    visibilityChanged: '分享已更新',
    visibilityFailed: '修改失败',
    link: '链接',
    password: '密码',
    expires: '有效期',
    days7: '7 天',
    days30: '30 天',
    never: '永不过期',
    create: '创建分享',
    revoke: '撤销',
    revoked: '已撤销分享',
    revokeFailed: '撤销失败',
    revokeNotAllowed: '只有此链接的创建者（或管理员）能撤销',
    copy: '复制',
    copied: (label) => `${label}已复制`,
    copyFailed: '复制失败，请手动选择复制',
    created: '已创建分享',
    passwordMin: '密码至少 6 个字符',
    building: '构建快照中，首次分享可能需要一两分钟',
    passwordOnce: '密码仅创建时显示，服务端不存明文',
    savePasswordNow: '请现在保存密码，之后不再显示。',
    neverExpires: '永不过期',
    expiresOn: (date) => `${date} 到期`,
    stage: {
      'build-cached': () => '使用缓存的静态构建',
      build: () => '正在构建静态站点，首次分享可能需要几分钟…',
      rebuild: () => '构建期间源文件有改动，重新构建一次…',
      building: ({ seconds }) => `正在构建静态站点… ${seconds ?? 0} 秒`,
      built: () => '静态构建完成',
      collecting: () => '正在收集页面用到的资源…',
      'snapshot-ready': ({ count }) => `快照已生成（${count ?? 0} 个资源）`,
      packing: ({ count }) => `正在打包快照（${count ?? 0} 个文件）…`,
      unchanged: () => '已发布的快照没有变化，不用上传',
      uploading: () => '正在上传到分享网关…',
      updating: () => '正在更新分享网关…',
    },
    shareFailed: '分享失败',
    streamEnded: '流意外中断',
    loading: '加载中…',
    loadFailed: '加载分享列表失败',
    upToDate: (published) => `已发布的就是最新版本（${published}）。`,
    staleSince: (changed) => `笔记于 ${changed} 有改动，链接仍是上一版。`,
    followHint: (minutes) => `笔记安静 ${minutes} 分钟后会自动发布。`,
    manualOnly: '本站只手动发布。',
    pinnedHint: (published) => `已钉住 ${published} 的版本，不会自动更新。`,
    publish: '发布这一版',
    publishing: '发布中…',
    published: '分享已更新',
    publishFailed: '发布失败',
    pin: '钉住当前版本',
    unpin: '解除钉住，跟随笔记',
    pinned: '已钉住，链接保持这一版',
    unpinned: '已恢复跟随笔记',
    pinFailed: '钉住状态没改成',
    dotCurrent: '已分享 · 链接是最新版',
    dotStale: '已分享 · 有未发布的改动',
    dotPinned: '已分享 · 已钉住某一版',
  },
  sync: {
    title: (peer) => `同步到 ${peer}`,
    loading: '加载中…',
    standing: {
      absent: (peer) => `还没同步到 ${peer}`,
      current: (peer) => `已同步到 ${peer}`,
      behind: (peer) => `有更新还没同步到 ${peer}`,
      changed: (peer) => `${peer} 那边改过这份副本`,
      occupied: (peer) => `${peer} 已有一篇同名笔记`,
      foreign: () => '这个位置被别处同步来的副本占着',
      pending: (peer) => `已提交，${peer} 正在检查`,
      rejected: (peer) => `被 ${peer} 退回`,
      refused: () => '这篇不能同步',
      unreachable: (peer) => `连不上 ${peer}`,
      unsettled: (peer) => `正在确认 ${peer} 那边的结果`,
    },
    rowState: {
      absent: '未同步',
      current: '已同步',
      behind: '有更新未同步',
      changed: '对方改过',
      occupied: '位置被占',
      foreign: '位置被占',
      pending: '检查中',
      rejected: '被退回',
      refused: '不能同步',
      unreachable: '连不上',
      unsettled: '确认结果中',
    },
    together: (unit) => `跟 ${unit} 一起同步`,
    planSummary: (notes, files, size) => `将同步 ${notes} 篇笔记、${files} 个文件（${size}）`,
    classification: '副本里的分类',
    degraded: (count, peer) => `${count} 处链接指向 ${peer} 没有的笔记，副本里会变成纯文字`,
    degradedIn: (note) => `在 ${note}`,
    publish: (peer) => `同步到 ${peer}`,
    publishAgain: '同步最新版本',
    overwrite: '覆盖对方的修改并同步',
    overwriteConfirm: (peer) => `${peer} 那边的修改会被覆盖掉。`,
    adopt: '用这篇替换对方那篇',
    adoptConfirm: (peer) => `${peer} 原来那篇会被这篇替换，旧内容还留在对方的 git 历史里。`,
    withdraw: '撤回',
    withdrawConfirm: (peer) => `从 ${peer} 上删掉这份副本？`,
    withdrawChangedConfirm: (peer) => `连同 ${peer} 那边的修改一起删掉这份副本？`,
    cancel: '取消',
    openCopy: '打开副本 ↗',
    synced: (time) => `同步于 ${time}`,
    occupiedExplain: (peer) => `${peer} 在同一个位置已经有一篇自己的笔记，同步过去会用这篇的副本替换它。`,
    foreignExplain: (peer) =>
      `${peer} 的这个位置被别的 wiki 同步来的副本占着，这篇同步不过去。要么把其中一篇换个路径，要么请那边先撤回它的副本。`,
    behindExplain: (synced, changed) =>
      changed ? `这篇在同步之后又改过（同步于 ${synced}，最近修改于 ${changed}）。` : `这篇在同步之后又改过（同步于 ${synced}）。`,
    changedExplain: '再同步会覆盖那边的修改。',
    changedBehind: '这篇本身也有新的修改。',
    refusedTitle: '不能同步的原因',
    unreachableExplain: (peer) => `访问 ${peer} 的仓库失败：`,
    pendingWithdraw: (peer) => `撤回已提交，${peer} 正在检查`,
    pendingExplain: (time) => `通常一两分钟（提交于 ${time}）。`,
    rejectedExplain: (peer, time) => `${peer} 的检查没通过（${time}），这次提交被退回。按下面的问题改好后再同步。`,
    rejectedWithdraw: (peer, time) => `${peer} 的检查没通过（${time}），撤回被退回。`,
    problemsFound: '检查发现的问题',
    error: {
      foreign: (peer) => `${peer} 的这个位置已经被别的 wiki 的副本占了。`,
      native: (peer) => `${peer} 在这个位置有自己的笔记，要替换请点“用这篇替换对方那篇”。`,
      gone: (peer) => `${peer} 上的副本已经被删掉了，重新同步就会再建一份。`,
      moved: (peer) => `${peer} 上的副本刚被更新过，看一下最新状态再试。`,
      changed: (peer) => `${peer} 那边改过这份副本，要覆盖请点“覆盖对方的修改并同步”。`,
      'digest-mismatch': () => '两边算出的版本号对不上，请把两个 wiki 的引擎升级到同一版本。',
      invalid: () => '没有提交，副本没通过本站的检查。',
      refused: () => '这篇不能同步。',
      busy: () => '这篇正在同步或撤回，等它完成再试。',
      pending: (peer) => `${peer} 还在检查上一次提交，等它有结果再试。`,
      rejected: (peer) => `被 ${peer} 退回：对方的检查没通过。`,
      unreachable: (peer, detail) => `连不上 ${peer}：${detail}`,
    },
    stage: {
      fetching: (peer) => `正在读取 ${peer} 的仓库…`,
      preparing: () => '正在准备副本…',
      checking: () => '正在用本站的检查过一遍副本…',
      submitting: (peer) => `正在提交到 ${peer}…`,
      waiting: (peer, seconds) =>
        seconds === undefined
          ? `已提交，等待 ${peer} 检查…`
          : `已提交，等待 ${peer} 检查…（已等 ${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}）`,
    },
    warning: {
      image: (url, note, peer) => `${note} 里的图片 ${url} 放在 ${peer} 没有的笔记里，副本里会显示不出来。`,
      element: (url, note, peer) => `${note} 里的链接 ${url} 指向 ${peer} 没有的笔记，副本里会失效。`,
    },
    refusal: {
      never: (note) => `${note} 写了 syndication: false，不同步到任何地方。`,
      copy: (note) => `${note} 本身就是从别的 wiki 同步来的副本。`,
      frontmatter: (note, detail) => `${note} 的 frontmatter 解析不了（${detail}）。`,
      'no-root': (note) => `${note} 没有默认语言的根笔记。`,
      'no-frontmatter': (note) => `${note} 没有 frontmatter，副本需要它。`,
      degrade: (note, target) => `${note} 里指向 ${target} 的链接变成纯文字后会改变前后文的意思，请改写这句话或换一种链接写法。`,
    },
    starting: { publish: '提交中…', withdraw: '撤回中…', overrides: '保存中…' },
    outcome: {
      publish: {
        accepted: (peer) => `已同步到 ${peer}`,
        pending: (peer) => `已提交，${peer} 还在检查`,
        rejected: (peer) => `被 ${peer} 退回：对方的检查没通过`,
        failed: (peer) => `同步到 ${peer} 没有成功`,
        unknown: (peer) => `已提交，但之后读不到 ${peer} 的状态，连上后会显示结果`,
      },
      withdraw: {
        accepted: (peer) => `已从 ${peer} 撤回`,
        pending: (peer) => `撤回已提交，${peer} 正在检查`,
        rejected: (peer) => `${peer} 的检查没通过，撤回被退回`,
        failed: (peer) => `从 ${peer} 撤回没有成功`,
        unknown: (peer) => `撤回已提交，但之后读不到 ${peer} 的状态，连上后会显示结果`,
      },
      overrides: {
        accepted: () => '已保存，下次同步时带过去',
        pending: () => '已保存，下次同步时带过去',
        rejected: () => '已保存，下次同步时带过去',
        failed: () => '保存没有成功',
        unknown: () => '已保存，下次同步时带过去',
      },
    },
    attemptFailed: {
      publish: (time, reason) => `${time} 的同步没有成功：${reason}`,
      withdraw: (time, reason) => `${time} 的撤回没有成功：${reason}`,
      overrides: (time, reason) => `${time} 的保存没有成功：${reason}`,
    },
    stillOpen: (peer) => `还有一次提交在等 ${peer} 检查，这里会接着问。`,
    unsettledExplain: {
      publish: (peer) => `上一次同步的结果没有传回来。这里会一直向 ${peer} 确认副本有没有进去，确认之前不能再发起别的操作。`,
      withdraw: (peer) => `上一次撤回的结果没有传回来。这里会一直向 ${peer} 确认副本有没有删掉，确认之前不能再发起别的操作。`,
    },
    queued: '已排队，等前面的笔记同步完再轮到它。',
    dequeue: '移出队列',
    rowQueued: '排队中',
    problemsCount: (count) => `检查发现的问题（${count}）`,
    overrides: {
      fold: '修改副本的分类',
      hint: (peer) => `这里写的字段只替换 ${peer} 副本里的对应值，写 null 表示副本里去掉这个字段；留空就沿用笔记本身的分类。`,
      label: '替换值（YAML）',
      save: '保存',
      notMap: '请按“字段: 值”逐行填写',
      invalid: (message) => `YAML 格式不对：${message}`,
      loadFailed: 'YAML 编辑器加载失败',
    },
    overview: {
      link: (count) => (count === null ? '全部同步笔记' : `全部同步笔记（${count}）`),
      title: (peer) => `同步到 ${peer} 的全部笔记`,
      back: '← 回到本篇',
      empty: '还没有同步过的笔记',
      missing: '本站已没有这篇',
      publish: '同步',
      publishAll: (count) => `同步全部有更新的（${count}）`,
      progress: (title, line) => `${title}：${line}`,
      done: (accepted, pending, failed) =>
        [`${accepted} 篇已同步`, pending ? `${pending} 篇还在检查` : '', failed ? `${failed} 篇没成功` : '']
          .filter(Boolean)
          .join('，'),
      loadFailed: '同步笔记列表加载失败',
    },
    copy: {
      chip: (wiki) => `副本 · 来自 ${wiki}`,
      notice: (wiki) => `这篇是从 ${wiki} 同步来的副本，只能在那边修改；在这里改的内容会在下次同步时被覆盖。`,
      revision: '版本',
    },
  },
};

const DE_TOOL_VERBS: Record<string, string> = {
  Read: 'Lesen',
  Edit: 'Bearbeiten',
  MultiEdit: 'Mehrfach bearbeiten',
  Write: 'Schreiben',
  NotebookEdit: 'Notebook bearbeiten',
  Grep: 'Durchsuchen',
  Glob: 'Dateien auflisten',
  Bash: 'Befehl',
  WebSearch: 'Websuche',
  WebFetch: 'Webseite abrufen',
  TodoWrite: 'Aufgaben aktualisieren',
  Task: 'Teilaufgabe',
  Agent: 'Teilaufgabe',
};

const DE_LOGIN_ERRORS: Record<LoginErrorCode, string> = {
  saml_config: 'SSO ist auf dieser Website nicht richtig eingerichtet.',
  saml_disabled: 'Die SSO-Anmeldung ist auf dieser Website ausgeschaltet.',
  saml_response: 'Die SSO-Antwort fehlte oder war nicht lesbar.',
  saml_invalid: 'Die SSO-Antwort ließ sich nicht verifizieren.',
  saml_error: 'Die SSO-Anmeldung ist fehlgeschlagen.',
  google_state: 'Die Google-Anmeldung ist abgelaufen oder wurde in einem anderen Browser gestartet – melde dich erneut an.',
  google_error: 'Die Google-Anmeldung ist fehlgeschlagen.',
  wrong_domain: 'Dein Konto gehört zu keiner zugelassenen E-Mail-Domain.',
  not_member: 'Dein Konto ist kein Mitglied dieser Website.',
  member_conflict: 'Diese Adresse ist als Commit-Adresse eines anderen Mitglieds eingetragen. Bitte eine Admin-Person bitten, das unter „Mitglieder“ zu klären.',
};

const DE_SHARE_ACTION: Record<ShareAction, string> = {
  publish: 'veröffentlichen',
  change: 'ändern',
  pin: 'festhalten',
  revoke: 'widerrufen',
};
const DE_VISIBILITY: Record<string, string> = { password: 'Mit Passwort', link: 'Alle mit dem Link', public: 'Öffentlich' };

const DE_ERRORS: ErrorTable = {
  'bad-request': ({ detail }) => `Die Anfrage ist fehlerhaft (${detail})`,
  'bad-path': ({ segment }) => `Ein Abschnitt der Adresse ist falsch kodiert: ${segment}`,
  'not-json': () => 'Der Inhalt der Anfrage muss als application/json gesendet werden',
  'bad-json': () => 'Der Inhalt der Anfrage ist kein gültiges JSON',
  'body-too-large': ({ limit }) => `Die Anfrage ist zu groß (höchstens ${limit} Byte)`,
  'cross-site': () => 'Anfrage von einer fremden Website abgelehnt',
  'sign-in-required': () => 'Bitte melde dich zuerst an',
  'admin-only': () => 'Das dürfen nur Admins',
  'not-member': () => 'Du bist kein Mitglied dieser Website',
  unexpected: ({ detail }) => `Ein Fehler ist aufgetreten: ${detail}`,
  internal: ({ id }) => `Interner Serverfehler (Kennung ${id})`,

  'dev-login-off': () =>
    'Die lokale Test-Anmeldung ist ausgeschaltet (inkbrush.config.ts → auth.dev; ohne ausdrückliches dev: true nur für Zugriffe vom eigenen Rechner)',
  'dev-login-fields': () => 'Ein Name und eine gültige E-Mail-Adresse sind nötig',
  'google-off': () => 'Die Google-Anmeldung ist auf dieser Website nicht aktiviert (inkbrush.config.ts → auth.google)',
  'google-unconfigured': () =>
    'Die Google-Anmeldung ist aktiviert, aber in der Umgebung fehlen GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
  'google-base-url': () => 'Außerhalb von localhost braucht die Google-Anmeldung auth.google.baseUrl (inkbrush.config.ts)',
  'saml-off': () => 'Die SAML-Anmeldung ist auf dieser Website nicht aktiviert (inkbrush.config.ts → auth.googleSaml)',
  'saml-unconfigured': () =>
    'Die SAML-Anmeldung ist aktiviert, aber nicht vollständig eingerichtet (entryPoint / idpEntityId / certFile / baseUrl)',

  'members-email': ({ email }) => `Ungültige E-Mail-Adresse: „${email}“`,
  'members-duplicate': ({ email }) => `E-Mail-Adresse doppelt: ${email}`,
  'members-role': ({ role, roles }) => `Unbekannte Rolle „${role}“ (erlaubt: ${roles.join(', ')})`,
  'members-admin': ({ role }) => `Mindestens ein „${role}“ muss bleiben`,
  'members-name': ({ email, max }) => `Der Name von ${email} muss in einer Zeile stehen, 1–${max} Zeichen, ohne < oder >`,
  'members-alias': ({ email, alias }) => `Weitere Adresse „${alias}“ von ${email} ist keine E-Mail-Adresse`,
  'members-alias-taken': ({ alias, owner }) => `${alias} gehört bereits zu ${owner}`,
  'members-stale': () => 'Die Mitgliederliste wurde inzwischen geändert und neu geladen – bitte die Änderung noch einmal machen',

  'note-not-found': () => 'Notiz nicht gefunden',
  'note-ambiguous': ({ id }) => `Die Notiz „${id}“ hat sowohl index.md als auch index.mdx – entferne eine davon`,
  copy: ({ wiki }) => `Diese Notiz ist eine Kopie aus ${wiki} – bearbeite sie dort`,
  'line-range': () => 'Der Zeilenbereich liegt außerhalb der Datei',
  'block-changed': () => 'Jemand anderes hat diesen Block geändert – lade die Seite neu und versuch es noch einmal',
  'save-would-not-build': ({ detail }) => `Die Notiz ließe sich nicht mehr bauen – nicht gespeichert: ${detail}`,
  'revision-not-found': () => 'Version nicht gefunden',
  'revert-whole-file': () => 'Operationen auf der ganzen Datei lassen sich nicht mit einem Klick zurücksetzen',
  'revert-no-change': () => 'Diese Version ändert keinen Inhalt',
  'revert-overwritten': () => 'Spätere Änderungen haben diese Version überschrieben – setz sie von Hand zurück',
  'revert-ambiguous': () => 'Der Zielinhalt kommt mehr als einmal vor – setz ihn von Hand zurück',

  'comment-empty': () => 'Der Kommentar darf nicht leer sein',
  'comment-too-long': ({ max }) => `Der Kommentar ist zu lang (mehr als ${max} Zeichen)`,
  'comment-not-found': () => 'Kommentar nicht gefunden',
  'comment-not-yours': () => 'Du kannst nur deine eigenen Kommentare löschen',

  'ai-busy-user': ({ max }) => `Bei dir laufen schon ${max} AI-Jobs – warte, bis einer fertig ist`,
  'ai-busy-machine': ({ max }) => `Auf dem Server laufen schon ${max} AI-Jobs – versuch es wieder, wenn einer fertig ist`,
  'chat-session': () =>
    'Dieses Gespräch ist nicht mehr bekannt (nach einem Neustart des Servers beginnen Gespräche neu) – starte ein neues Gespräch',
  'job-setup': ({ detail }) => `Der Job ließ sich nicht vorbereiten: ${detail}`,
  'job-range-gone': () =>
    'Die ausgewählten Zeilen gibt es nicht mehr (die Notiz hat sich geändert, während der Job wartete) – lade neu und versuch es noch einmal',
  'translate-same': () => 'Die Zielsprache ist die aktuelle Sprache',
  'translate-unsupported': ({ lang }) => `Nicht unterstützte Zielsprache: ${lang}`,
  'translate-exists': ({ id }) => `Diese Sprachfassung gibt es schon: ${id}`,
  'translate-target': ({ id }) => `Ungültige Ziel-ID: ${id}`,
  'claude-unavailable': ({ detail }) =>
    `Die claude-CLI ließ sich nicht starten: ${detail} (mit WIKI_CLAUDE_BIN auf sie zeigen)`,
  'job-timeout': ({ seconds }) => `Der Job hat das Zeitlimit überschritten (${seconds} s) und wurde beendet`,
  'client-disconnected': () => 'Der Browser hat die Verbindung getrennt',
  'job-error': ({ detail }) => `Der AI-Job ist fehlgeschlagen${detail ? `: ${detail}` : ''}`,
  'job-output-overflow': ({ megabytes }) =>
    `claude hat eine Ausgabezeile von über ${megabytes} MB geschrieben, ohne sie abzuschließen – der Job wurde beendet`,
  'job-exited': ({ exitCode, detail, ignoredLines }) =>
    `claude hat sich unerwartet beendet (Exit-Code ${exitCode})${detail ? `: ${detail}` : ''}${
      ignoredLines > 0 ? ` (${ignoredLines} Ausgabezeilen ohne gültiges JSON ignoriert)` : ''
    }`,
  'job-deleted-note': ({ file }) => `Der Job hat die Datei der Notiz selbst gelöscht (${file})`,
  'job-no-baseline': ({ file }) => `Die Notizdatei (${file}) hat keinen Ausgangsstand, in dem sich ein Block bearbeiten ließe`,
  'job-outside-block': ({ file, start, end }) =>
    `Der Job hat Zeilen außerhalb des ausgewählten Blocks (L${start}-${end}) von ${file} geändert`,
  'job-touched-source': ({ file }) => `Der Job hat die Ausgangsnotiz geändert (${file})`,
  'job-stray-file': ({ file }) => `Der Job hat eine Datei außer dem Ziel geändert (${file})`,
  'job-no-target': ({ file }) => `Der Job hat die Zieldatei nicht erzeugt (${file})`,
  'job-would-not-build': ({ detail }) => `Das Ergebnis ließe sich nicht bauen: ${detail}`,
  'job-conflict': ({ file }) => `„${file}“ wurde geändert, während der Job lief`,

  'share-off': () => 'Teilen ist auf dieser Website nicht eingerichtet (inkbrush.config.ts → share)',
  'share-unconfigured': () => 'Teilen ist aktiviert, aber gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN fehlen',
  'share-exists': () => 'Diese Notiz hat schon einen aktiven Freigabelink – widerrufe ihn zuerst',
  'share-creating': () => 'Für diese Notiz wird gerade eine Freigabe erstellt – warte, bis sie fertig ist',
  'share-busy': () => 'Diese Freigabe wird gerade veröffentlicht – warte, bis das fertig ist',
  'share-not-found': () => 'Freigabe nicht gefunden',
  'share-not-yours': ({ action }) =>
    `Nur wer die Freigabe erstellt hat (oder ein Admin), kann sie ${DE_SHARE_ACTION[action]}`,
  'share-password-short': () => 'Das Passwort muss mindestens 6 Zeichen haben',
  'share-password-unexpected': ({ visibility }) =>
    `Eine Freigabe „${DE_VISIBILITY[visibility] ?? visibility}“ hat kein Passwort`,
  'share-alias-not-public': () => 'Nur eine öffentliche Freigabe kann eine Adresse haben',
  'share-alias-invalid': () => 'Adresse: Kleinbuchstaben, Ziffern und Bindestriche im Inneren, höchstens 64 Zeichen',
  'share-unpin-first': () =>
    'Lös die Freigabe zuerst – sie öffentlich zu machen würde die Notiz in ihrem jetzigen Stand veröffentlichen',
  'share-revoked-meanwhile': () => 'Die Freigabe wurde widerrufen, während sie geändert wurde',
  'gateway-token': () => 'Das Share-Gateway hat SHARE_GATEWAY_TOKEN abgelehnt',
  'gateway-status': ({ status, detail }) => `Fehler beim Share-Gateway (HTTP ${status})${detail ? `: ${detail}` : ''}`,
  'gateway-unreachable': ({ url, detail }) => `Das Share-Gateway ist nicht erreichbar (${url}): ${detail}`,
  'gateway-refused': ({ detail }) => `Das Share-Gateway hat abgelehnt: ${detail}`,
  'gateway-lost': () => 'Das Share-Gateway hat diese Freigabe nicht mehr – widerrufe sie und teile die Notiz neu',
  'gateway-unknown-share': () =>
    'Das Share-Gateway hat diese Freigabe nicht mehr, oder es kennt noch keine Sichtbarkeitsstufen',
  'gateway-outdated': () =>
    'Das Share-Gateway kennt noch keine Freigaben per Link oder öffentliche Freigaben – aktualisiere das Gateway oder teile mit Passwort',
  'snapshot-unstable': () => 'Die Website ändert sich laufend, während der Snapshot gebaut wird – versuch es, wenn die Änderungen ruhen',
  'snapshot-too-large': ({ size, limit }) => `Das Snapshot-Paket hat ${size} MiB und liegt über der Grenze von ${limit} MiB`,
  'build-missing': ({ path }) => `Das astro-Programm fehlt (${path}) – installiere zuerst die Abhängigkeiten der Website`,
  'build-start': ({ detail }) => `Der astro-Build ließ sich nicht starten: ${detail}`,
  'build-timeout': ({ minutes }) => `Der astro-Build hat das Zeitlimit überschritten (${minutes} min) und wurde beendet`,
  'build-failed': ({ exitCode, detail }) =>
    `Der astro-Build ist fehlgeschlagen (Exit-Code ${exitCode})${detail ? `: …${detail}` : ''}`,

  'syndication-off': () => 'Syndication ist auf dieser Website nicht eingerichtet (inkbrush.config.ts → syndication)',
  'peer-unknown': ({ peer }) => `Kein solches Ziel-Wiki: ${peer}`,
  'unit-unknown': ({ unit }) => `„${unit}“ gibt es hier nicht`,
  'overrides-no-frontmatter': () => 'Die Notiz hat keinen lesbaren Frontmatter-Block',
  'overrides-never': () => 'Die Notiz sagt syndication: false – entferne das zuerst',

  'inbox-off': () => 'Die Inbox ist auf dieser Website nicht aktiviert (inkbrush.config.ts → inbox.dir)',
  'inbox-missing': ({ path }) => `Datei nicht vorhanden: ${path}`,

  'storage-unavailable': () => 'Der Browser-Speicher ist nicht verfügbar – die Änderung lässt sich nicht behalten',
  'playground-unavailable': () => 'Im Playground nicht verfügbar',
};

const de: Strings = {
  common: {
    requestFailed: 'Anfrage fehlgeschlagen',
    tool: (label) => translateTool(label, DE_TOOL_VERBS),
    http: (status) =>
      status === 0
        ? 'Die Verbindung zum Server dieses Wikis ist abgerissen – prüf dein Netzwerk und versuch es noch einmal.'
        : status === 401
          ? 'Deine Anmeldung ist abgelaufen – melde dich erneut an.'
          : status === 403
            ? 'Dafür hast du keine Berechtigung.'
            : status === 404
              ? 'Nicht gefunden – die Notiz wurde vielleicht verschoben oder gelöscht.'
              : status === 413
                ? 'Die Anfrage ist für diesen Server zu groß.'
                : status >= 500
                  ? `Auf dem Server dieses Wikis ist ein Fehler aufgetreten (HTTP ${status}).`
                  : `Die Anfrage ist fehlgeschlagen (HTTP ${status}).`,
  },
  errors: DE_ERRORS,
  auth: {
    chipLabel: 'Konto',
    accountPanel: 'Konto',
    signIn: 'Anmelden',
    panelTitle: 'Anmelden',
    googleButton: 'Mit Google Workspace anmelden',
    samlButton: 'Mit Google Workspace SSO anmelden',
    notConfigured: 'Nicht eingerichtet',
    googleMissingEnv:
      'Aktiviert, aber die Umgebungsvariablen GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fehlen (siehe Doku)',
    samlMissingConfig:
      'Aktiviert, aber die Konfiguration ist unvollständig (SSO URL / IdP entity id / Zertifikat / baseUrl fehlen, siehe Doku)',
    devLoginLabel: 'Lokale Test-Anmeldung',
    nickname: 'Anzeigename',
    emailPlaceholder: 'you@team.com',
    enter: 'Weiter',
    or: 'oder',
    signOut: 'Abmelden',
    signedIn: (name) => `Angemeldet als ${name}`,
    signedOut: 'Abgemeldet',
    signInFailed: 'Anmeldung fehlgeschlagen',
    loginError: (code) => loginErrorOf(DE_LOGIN_ERRORS, code) ?? `Anmeldung fehlgeschlagen (${code})`,
    provider: {
      dev: 'Lokale Testsitzung',
      google: 'Google Workspace',
      'google-saml': 'Google Workspace SSO',
    },
    noProviders: 'Keine Anmeldemethode aktiviert (in inkbrush.config.ts → auth einrichten)',
    role: (role) => `Rolle: ${role ?? '—'}`,
    members: 'Mitglieder',
    rename: 'Namen ändern',
    nameField: 'Dein Name',
    renamedSelf: (name) => `Du heißt jetzt ${name}`,
  },
  identity: {
    title: 'Mitglieder',
    count: (n) => (n === 1 ? '1 Person' : `${n} Personen`),
    lede: 'Der Name erscheint in Autorenzeilen, Erwähnungen, Kommentaren und im Änderungsverlauf. Commit-Adressen: Git-Commits mit diesen Adressen zählen als Commits dieser Person.',
    searchPlaceholder: 'Nach Name oder Adresse suchen',
    close: 'Schließen',
    noMatch: (q) => `Niemand passt zu „${q}“.`,
    nameLabel: (email) => `Name von ${email}`,
    renamed: (name) => `Umbenannt in ${name}`,
    you: 'Du',
    roleLabel: (name) => `Rolle von ${name}`,
    aliasesLabel: 'Commit-Adressen',
    aliasHint: 'Weitere Adressen in den Git-Commits dieser Person, etwa eine private Adresse',
    aliasPlaceholder: 'name@example.com',
    addAlias: 'Adresse hinzufügen',
    addAliasLabel: (name) => `Commit-Adresse für ${name} hinzufügen`,
    removeAlias: (alias) => `${alias} entfernen`,
    aliasAdded: (alias) => `${alias} hinzugefügt`,
    addTitle: 'Mitglied hinzufügen',
    colEmail: 'E-Mail',
    colName: 'Name',
    colRole: 'Rolle',
    namePlaceholder: 'Name',
    emailPlaceholder: 'name@team.com',
    add: 'Hinzufügen',
    added: (name) => `${name} hinzugefügt`,
    remove: 'Entfernen',
    removeLabel: (name) => `${name} entfernen`,
    confirmRemove: (name) => `Noch einmal klicken, um ${name} zu entfernen`,
    confirmRemoveShort: 'Entfernen?',
    removed: (name) => `${name} entfernt`,
    saved: 'Gespeichert',
    saveFailed: 'Speichern fehlgeschlagen',
    loadFailed: 'Mitglieder konnten nicht geladen werden',
    emailRequired: 'Bitte eine E-Mail-Adresse eingeben',
    adminNote: (role) => `Mindestens ein „${role}“ bleibt immer.`,
  },
  blocks: {
    toolbar: 'Block-Werkzeuge',
    focusHint: 'Enter öffnet die Block-Werkzeuge · Pfeil hoch/runter wechselt zwischen Blöcken',
    edit: 'Diesen Block bearbeiten (öffnet den Quelltext)',
    ai: 'Claude diesen Block bearbeiten lassen',
    history: 'Versionsverlauf / Zurücksetzen',
    signInFirst: 'Melde dich an, um zu bearbeiten',
    editorLoadFailed: 'Der Editor konnte nicht geladen werden – lade die Seite neu und versuch es noch einmal',
    aiLoadFailed: 'Das AI-Panel konnte nicht geladen werden – lade die Seite neu und versuch es noch einmal',
    historyLoadFailed: 'Der Versionsverlauf konnte nicht geladen werden – lade die Seite neu und versuch es noch einmal',
  },
  editor: {
    title: (jsx) => (jsx ? `Bearbeiten · Komponentenblock ${jsx}` : 'Bearbeiten · Markdown-Block'),
    frontmatterTitle: 'Bearbeiten · Frontmatter (YAML)',
    shortcutHint: '⌘/Strg + Enter speichert · Esc bricht ab',
    placeholder: 'MDX-Quelltext…',
    frontmatterPlaceholder: 'YAML-Frontmatter…',
    save: 'Speichern',
    cancel: 'Abbrechen',
    validating: 'Wird geprüft…',
    savedReloading: 'Gespeichert · wird neu geladen…',
    saved: 'Gespeichert',
    saveFailed: 'Speichern fehlgeschlagen',
    readFailed: 'Der Quelltext des Blocks konnte nicht gelesen werden',
    empty: '(leer)',
    previewFailed: 'Vorschau fehlgeschlagen',
    jsxNoPreview: (name) =>
      `Komponentenblöcke ⟨${name ?? 'Komponente'}⟩ haben keine eigene Vorschau – die Seite lädt direkt nach dem Speichern neu`,
    frontmatterNoPreview:
      'Frontmatter hat keine Vorschau – Titel, Beschreibung und der übrige Seitenkopf werden direkt nach dem Speichern neu gerendert',
  },
  ai: {
    title: (start, end) => `Claude · Block L${start}–${end} bearbeiten`,
    placeholder: (jsx) => `Sag Claude, was an diesem ${jsx ? `⟨${jsx}⟩-` : ''}Block geändert werden soll…`,
    inputLabel: 'Anweisung für Claude',
    run: 'Von Claude bearbeiten lassen',
    working: 'Claude bearbeitet…',
    done: 'Claude ist fertig – die Seite wird neu geladen…',
    jobFailed: 'Job fehlgeschlagen',
    unchanged: 'nichts wurde geändert',
    streamEnded: 'Die Verbindung brach ab, bevor der Job fertig war – versuch es noch einmal',
    quick: [
      {
        label: 'Glätten',
        instruction:
          'Überarbeite die Formulierungen in diesem Block: flüssiger und genauer, ohne den technischen Inhalt oder die Gesamtlänge zu ändern.',
      },
      {
        label: 'Strenger',
        instruction:
          'Formuliere diesen Block strenger: ergänze nötige Einschränkungen und korrigiere ungenaue Aussagen (der bisherige Schreibstil bleibt).',
      },
      {
        label: 'Kürzen',
        instruction:
          'Kürze diesen Block auf etwa zwei Drittel seiner Länge: Redundantes streichen, jede Kernaussage und jede Formel behalten.',
      },
      {
        label: 'Formeln prüfen',
        instruction:
          'Prüfe die Mathematik in diesem Block (einheitliche Notation, Hoch- und Tiefstellungen, Einheiten) und behebe gefundene Fehler; wenn alles stimmt, ändere nichts.',
      },
    ],
  },
  chat: {
    title: 'Claude · Notiz-Assistent',
    dialogLabel: 'Claude-Assistent',
    fabTitle: 'Claude fragen / AI-Aktionen',
    inputPlaceholder: 'Frag Claude zu dieser Notiz… (Enter zum Senden)',
    inputLabel: 'Nachricht an Claude',
    send: 'Senden',
    newChat: 'Neues Gespräch',
    collapse: 'Einklappen',
    thinking: 'Claude denkt nach…',
    emptyHint: 'Frag etwas zu dieser Notiz; Claude liest die Quelldatei direkt auf dem Server.',
    newChatStarted: 'Neues Gespräch begonnen',
    signInFirst: 'Melde dich zuerst an',
    translateConfirm: (label) =>
      `Mit Claude die Fassung auf ${label} erzeugen?\nDie ganze Notiz wird in der Zielsprache neu erzählt (Struktur und Formeln bleiben erhalten), und die Sprachtabellen der Demos werden mit aktualisiert. Das dauert ein paar Minuten.`,
    translateAction: (label) => `✦ Fassung auf ${label} erzeugen (vollständig neu erzählte Übersetzung)`,
    translateDone: 'Übersetzung fertig – die Seite wird neu geladen…',
    streamEnded: 'Die Verbindung brach ab, bevor die Antwort fertig war – versuch es noch einmal',
    notice: {
      'no-change': 'Es war keine Änderung nötig.',
      'commit-failed': 'Gespeichert, aber der git-Commit ist fehlgeschlagen – sieh im Server-Log nach.',
    },
  },
  history: {
    via: {
      manual: 'Manuelle Bearbeitung',
      claude: 'Bearbeitung durch Claude',
      translate: 'AI-Übersetzung',
      inbox: 'Import aus der Inbox',
      revert: 'Zurückgesetzt',
    },
    title: (start, end) => `Versionsverlauf des Blocks · L${start}-${end}`,
    wholeFile: 'Ganze Datei',
    wholeFileNote: 'Operation auf der ganzen Datei – rückgängig machen geht nur mit git, nicht mit einem Klick',
    viewDiff: 'Änderungen ansehen',
    revert: '⟲ Diese Änderung zurücksetzen',
    revertTitle: 'Den Inhalt von vor dieser Änderung wiederherstellen',
    reverted: 'Zurückgesetzt – die Seite wird neu geladen…',
    revertFailed: 'Zurücksetzen fehlgeschlagen',
    signInToRevert: 'Melde dich an, um zurückzusetzen',
    noRecords: 'Für diesen Block gibt es noch keine Versionen',
    loadFailed: 'Der Versionsverlauf konnte nicht geladen werden',
    showMore: (n) => (n === 1 ? '1 ältere Version anzeigen' : `${n} ältere Versionen anzeigen`),
  },
  comments: {
    sectionTitle: 'Kommentare',
    count: (n) => (n === 0 ? 'Noch keine Kommentare' : n === 1 ? '1 Kommentar' : `${n} Kommentare`),
    placeholder: 'Schreib einen Kommentar… Markdown und $…$-Mathematik werden unterstützt',
    inputLabel: 'Kommentar',
    preview: 'Vorschau',
    keepEditing: 'Weiter bearbeiten',
    post: 'Absenden',
    posted: 'Gesendet',
    postFailed: 'Senden fehlgeschlagen',
    delete: 'Löschen',
    deleteFailed: 'Löschen fehlgeschlagen',
    confirmDelete: 'Diesen Kommentar löschen?',
    rendering: 'Wird gerendert…',
    previewFailed: 'Vorschau fehlgeschlagen',
    signInPrompt: 'Melde dich an, um mitzudiskutieren – ',
    signIn: 'Anmelden',
    postingAs: (name) => `Du schreibst als ${name} · Markdown / $Mathematik$ / Codeblöcke`,
  },
  share: {
    title: 'Teilen',
    chip: 'Teilen',
    chipReady: 'Diese Notiz teilen',
    chipUnconfigured: 'Teilen ist aktiviert, aber gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN fehlen',
    intro: 'Veröffentliche einen statischen Snapshot dieser Notiz – mit Passwort, für alle mit dem Link oder ganz öffentlich.',
    visibility: 'Wer kann lesen',
    visPassword: 'Mit Passwort',
    visPasswordHint: 'Link und Passwort; das Passwort wird nur einmal angezeigt.',
    visLink: 'Alle mit dem Link',
    visLinkHint: 'Der nicht erratbare Link ist der Schlüssel; Suchmaschinen werden gebeten, fernzubleiben.',
    visPublic: 'Öffentlich',
    visPublicHint: 'Offen für alle und für Suchmaschinen, unter einer lesbaren Adresse.',
    alias: 'Adresse',
    aliasHint: 'Kleinbuchstaben, Ziffern und Bindestriche; leer lassen, um die ID zu verwenden.',
    aliasInvalid: 'Adresse: Kleinbuchstaben, Ziffern und Bindestriche im Inneren, höchstens 64 Zeichen',
    readableBy: (label) => `Lesbar für: ${label}`,
    changeVisibility: 'Ändern, wer lesen kann',
    apply: 'Übernehmen',
    visibilityChanged: 'Freigabe aktualisiert',
    visibilityFailed: 'Die Freigabe konnte nicht geändert werden',
    link: 'Link',
    password: 'Passwort',
    expires: 'Ablauf',
    days7: '7 Tage',
    days30: '30 Tage',
    never: 'Nie',
    create: 'Freigabe erstellen',
    revoke: 'Widerrufen',
    revoked: 'Freigabe widerrufen',
    revokeFailed: 'Widerrufen fehlgeschlagen',
    revokeNotAllowed: 'Nur wer den Link erstellt hat (oder ein Admin), kann ihn widerrufen',
    copy: 'Kopieren',
    copied: (label) => `${label} kopiert`,
    copyFailed: 'Kopieren fehlgeschlagen – markiere und kopiere von Hand',
    created: 'Freigabe erstellt',
    passwordMin: 'Das Passwort muss mindestens 6 Zeichen haben',
    building: 'Snapshot wird gebaut… beim ersten Teilen kann das eine Minute dauern',
    passwordOnce: 'Das Passwort wurde nur beim Erstellen angezeigt (nicht gespeichert)',
    savePasswordNow: 'Speichere das Passwort jetzt – es wird nicht noch einmal angezeigt.',
    neverExpires: 'Läuft nie ab',
    expiresOn: (date) => `Läuft am ${date} ab`,
    stage: {
      'build-cached': () => 'Der zwischengespeicherte statische Build wird verwendet',
      build: () => 'Die statische Website wird gebaut – beim ersten Teilen kann das ein paar Minuten dauern…',
      rebuild: () => 'Die Eingaben haben sich während des Builds geändert – es wird noch einmal gebaut…',
      building: ({ seconds }) => `Die statische Website wird gebaut… ${seconds ?? 0} s`,
      built: () => 'Statischer Build fertig',
      collecting: () => 'Die Ressourcen der Seite werden gesammelt…',
      'snapshot-ready': ({ count }) => `Snapshot fertig (${count ?? 0} Ressourcen)`,
      packing: ({ count }) => `Der Snapshot wird gepackt (${count ?? 0} Dateien)…`,
      unchanged: () => 'Der veröffentlichte Snapshot ist schon aktuell – nichts hochzuladen',
      uploading: () => 'Wird zum Share-Gateway hochgeladen…',
      updating: () => 'Das Share-Gateway wird aktualisiert…',
    },
    shareFailed: 'Teilen fehlgeschlagen',
    streamEnded: 'Die Verbindung endete ohne Ergebnis',
    loading: 'Wird geladen…',
    loadFailed: 'Die Freigaben konnten nicht geladen werden',
    upToDate: (published) => `Die veröffentlichte Fassung ist aktuell (${published}).`,
    staleSince: (changed) => `Die Notiz hat sich geändert (${changed}) – der Link zeigt noch die vorherige Fassung.`,
    followHint: (minutes) => `Sie wird von selbst veröffentlicht, sobald die Notiz ${minutes} Min. lang unverändert bleibt.`,
    manualOnly: 'Diese Website veröffentlicht nur von Hand.',
    pinnedHint: (published) => `Auf die Fassung vom ${published} festgehalten – sie aktualisiert sich nie von selbst.`,
    publish: 'Diese Fassung veröffentlichen',
    publishing: 'Wird veröffentlicht…',
    published: 'Freigabe aktualisiert',
    publishFailed: 'Veröffentlichen fehlgeschlagen',
    pin: 'Diese Fassung festhalten',
    unpin: 'Lösen – der Notiz folgen',
    pinned: 'Festgehalten – der Link behält diese Fassung',
    unpinned: 'Folgt wieder der Notiz',
    pinFailed: 'Das Festhalten ließ sich nicht ändern',
    dotCurrent: 'Geteilt · der Link ist aktuell',
    dotStale: 'Geteilt · unveröffentlichte Änderungen',
    dotPinned: 'Geteilt · auf eine Fassung festgehalten',
  },
  sync: {
    title: (peer) => `Mit ${peer} synchronisieren`,
    loading: 'Wird geladen…',
    standing: {
      absent: (peer) => `Noch nicht auf ${peer}`,
      current: (peer) => `Mit ${peer} synchronisiert · aktuell`,
      behind: (peer) => `Mit ${peer} synchronisiert · die Notiz hat sich seitdem geändert`,
      changed: (peer) => `Jemand hat die Kopie auf ${peer} geändert`,
      occupied: (peer) => `${peer} hat unter dieser Adresse eine eigene Notiz`,
      foreign: (peer) => `${peer} hat unter dieser Adresse die Kopie eines anderen Wikis`,
      pending: (peer) => `Eingereicht · ${peer} prüft sie`,
      rejected: (peer) => `Von ${peer} zurückgewiesen`,
      refused: () => 'Diese Notiz kann nicht synchronisiert werden',
      unreachable: (peer) => `${peer} ist nicht erreichbar`,
      unsettled: (peer) => `Es wird geprüft, wie es auf ${peer} ausgegangen ist`,
    },
    rowState: {
      absent: 'nicht synchronisiert',
      current: 'aktuell',
      behind: 'hier geändert',
      changed: 'dort geändert',
      occupied: 'Adresse belegt',
      foreign: 'Adresse belegt',
      pending: 'wird geprüft',
      rejected: 'zurückgewiesen',
      refused: 'nicht synchronisierbar',
      unreachable: 'nicht erreichbar',
      unsettled: 'Ergebnis wird geprüft',
    },
    together: (unit) => `Wird zusammen mit ${unit} synchronisiert`,
    planSummary: (notes, files, size) =>
      `${notes === 1 ? '1 Notiz' : `${notes} Notizen`}, ${files === 1 ? '1 Datei' : `${files} Dateien`} (${size}) werden veröffentlicht`,
    classification: 'In der Kopie',
    degraded: (count, peer) =>
      `${count === 1 ? '1 Link verweist' : `${count} Links verweisen`} auf Notizen, die ${peer} nicht hat – in der Kopie reiner Text`,
    degradedIn: (note) => `in ${note}`,
    publish: (peer) => `Auf ${peer} veröffentlichen`,
    publishAgain: 'Diese Fassung veröffentlichen',
    overwrite: 'Veröffentlichen und überschreiben',
    overwriteConfirm: (peer) => `Die Änderungen auf ${peer} gehen verloren.`,
    adopt: 'Durch diese Notiz ersetzen',
    adoptConfirm: (peer) =>
      `Die eigene Notiz von ${peer} wird durch diese ersetzt; ihr alter Text bleibt in der git-Historie von ${peer}.`,
    withdraw: 'Zurückziehen',
    withdrawConfirm: (peer) => `Die Kopie von ${peer} entfernen?`,
    withdrawChangedConfirm: (peer) => `Die Kopie von ${peer} entfernen, samt den dort gemachten Änderungen?`,
    cancel: 'Abbrechen',
    openCopy: 'Kopie öffnen ↗',
    synced: (time) => `Synchronisiert am ${time}`,
    occupiedExplain: (peer) =>
      `${peer} hat unter dieser Adresse schon eine eigene Notiz. Beim Veröffentlichen wird sie durch eine Kopie dieser Notiz ersetzt.`,
    foreignExplain: (peer) =>
      `${peer} hat unter dieser Adresse eine Kopie aus einem anderen Wiki, deshalb kann diese Notiz dort nicht hin. Verschieb eine der beiden Notizen an eine andere Adresse oder lass das andere Wiki seine Kopie zurückziehen.`,
    behindExplain: (synced, changed) =>
      changed
        ? `Diese Notiz wurde nach der synchronisierten Fassung geändert (synchronisiert am ${synced}, zuletzt geändert am ${changed}).`
        : `Diese Notiz wurde nach der synchronisierten Fassung geändert (synchronisiert am ${synced}).`,
    changedExplain: 'Erneutes Veröffentlichen überschreibt die dort gemachten Änderungen.',
    changedBehind: 'Auch diese Notiz hat sich geändert.',
    refusedTitle: 'Warum sie nicht synchronisiert werden kann',
    unreachableExplain: (peer) => `Das Repository von ${peer} war nicht erreichbar:`,
    pendingWithdraw: (peer) => `Zurückziehen eingereicht · ${peer} prüft es`,
    pendingExplain: (time) => `Das dauert meist ein, zwei Minuten (eingereicht am ${time}).`,
    rejectedExplain: (peer, time) =>
      `Die Prüfungen von ${peer} haben die Einreichung zurückgewiesen (${time}). Behebe, was sie gefunden haben, und veröffentliche dann erneut.`,
    rejectedWithdraw: (peer, time) => `Die Prüfungen von ${peer} haben das Zurückziehen zurückgewiesen (${time}).`,
    problemsFound: 'Was die Prüfungen gefunden haben',
    error: {
      foreign: (peer) => `${peer} hat unter dieser Adresse jetzt die Kopie eines anderen Wikis.`,
      native: (peer) => `${peer} hat unter dieser Adresse eine eigene Notiz – sie zu ersetzen braucht eine ausdrückliche Entscheidung.`,
      gone: (peer) => `Die Kopie wurde inzwischen von ${peer} entfernt – veröffentliche erneut, um sie neu anzulegen.`,
      moved: (peer) => `Die Kopie auf ${peer} hat sich gerade geändert – prüf ihren Stand und versuch es noch einmal.`,
      changed: (peer) => `Jemand hat die Kopie auf ${peer} bearbeitet – sie zu überschreiben braucht eine ausdrückliche Entscheidung.`,
      'digest-mismatch': () => 'Die beiden Wikis berechnen Revisionen unterschiedlich – nutze auf beiden dieselbe Engine-Version.',
      invalid: () => 'Nicht eingereicht – die Kopie besteht die Prüfungen dieses Wikis nicht.',
      refused: () => 'Diese Notiz kann nicht synchronisiert werden.',
      busy: () => 'Diese Notiz wird gerade veröffentlicht oder zurückgezogen – warte, bis das fertig ist.',
      pending: (peer) => `${peer} prüft noch die letzte Einreichung – warte auf die Antwort.`,
      rejected: (peer) => `Von ${peer} zurückgewiesen – die Prüfungen dort haben die Kopie abgelehnt.`,
      unreachable: (peer, detail) => `${peer} ist nicht erreichbar: ${detail}`,
    },
    stage: {
      fetching: (peer) => `Das Repository von ${peer} wird gelesen…`,
      preparing: () => 'Die Kopie wird vorbereitet…',
      checking: () => 'Die Kopie wird mit den Prüfungen dieses Wikis geprüft…',
      submitting: (peer) => `Wird bei ${peer} eingereicht…`,
      waiting: (peer, seconds) =>
        seconds === undefined
          ? `Eingereicht – warte auf die Prüfungen von ${peer}…`
          : `Eingereicht – warte auf die Prüfungen von ${peer}… (${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`})`,
    },
    warning: {
      image: (url, note, peer) =>
        `Das Bild ${url} in ${note} liegt in einer Notiz, die ${peer} nicht hat – in der Kopie wird es nicht angezeigt.`,
      element: (url, note, peer) =>
        `Der Link ${url} in ${note} verweist auf eine Notiz, die ${peer} nicht hat – in der Kopie ist er kaputt.`,
    },
    refusal: {
      never: (note) => `${note} sagt syndication: false – sie wird nirgendwohin synchronisiert.`,
      copy: (note) => `${note} ist selbst eine Kopie aus einem anderen Wiki.`,
      frontmatter: (note, detail) => `Die Frontmatter von ${note} lässt sich nicht parsen (${detail}).`,
      'no-root': (note) => `${note} hat keine Stammnotiz in der Standardsprache.`,
      'no-frontmatter': (note) => `${note} hat keinen Frontmatter-Block – eine Kopie braucht einen.`,
      degrade: (note, target) =>
        `In ${note} kann der Link auf ${target} nicht zu reinem Text werden, ohne den Sinn des umgebenden Texts zu ändern – formuliere den Satz um oder setze den Link anders.`,
    },
    starting: { publish: 'Wird eingereicht…', withdraw: 'Wird zurückgezogen…', overrides: 'Wird gespeichert…' },
    outcome: {
      publish: {
        accepted: (peer) => `Mit ${peer} synchronisiert`,
        pending: (peer) => `Eingereicht – ${peer} prüft noch`,
        rejected: (peer) => `Von ${peer} zurückgewiesen – die Prüfungen dort haben die Kopie abgelehnt`,
        failed: (peer) => `Das Veröffentlichen auf ${peer} hat nicht geklappt`,
        unknown: (peer) =>
          `Eingereicht, aber ${peer} war danach nicht lesbar – die Antwort erscheint, sobald es erreichbar ist`,
      },
      withdraw: {
        accepted: (peer) => `Von ${peer} zurückgezogen`,
        pending: (peer) => `Zurückziehen eingereicht – ${peer} prüft es`,
        rejected: (peer) => `Die Prüfungen von ${peer} haben das Zurückziehen abgelehnt`,
        failed: (peer) => `Das Zurückziehen von ${peer} hat nicht geklappt`,
        unknown: (peer) =>
          `Zurückziehen eingereicht, aber ${peer} war danach nicht lesbar – die Antwort erscheint, sobald es erreichbar ist`,
      },
      overrides: {
        accepted: () => 'Gespeichert – das nächste Veröffentlichen nimmt es mit',
        pending: () => 'Gespeichert – das nächste Veröffentlichen nimmt es mit',
        rejected: () => 'Gespeichert – das nächste Veröffentlichen nimmt es mit',
        failed: () => 'Das Speichern hat nicht geklappt',
        unknown: () => 'Gespeichert – das nächste Veröffentlichen nimmt es mit',
      },
    },
    attemptFailed: {
      publish: (time, reason) => `Das Veröffentlichen vom ${time} hat nicht geklappt: ${reason}`,
      withdraw: (time, reason) => `Das Zurückziehen vom ${time} hat nicht geklappt: ${reason}`,
      overrides: (time, reason) => `Das Speichern vom ${time} hat nicht geklappt: ${reason}`,
    },
    stillOpen: (peer) => `Eine Einreichung bei ${peer} wartet noch auf die Prüfungen; hier wird weiter nachgefragt.`,
    unsettledExplain: {
      publish: (peer) =>
        `Die Antwort auf das letzte Veröffentlichen ist verloren gegangen. Hier wird bei ${peer} nachgefragt, bis feststeht, ob die Kopie angekommen ist; bis dahin kann nichts anderes gesendet werden.`,
      withdraw: (peer) =>
        `Die Antwort auf das letzte Zurückziehen ist verloren gegangen. Hier wird bei ${peer} nachgefragt, bis feststeht, ob die Kopie entfernt wurde; bis dahin kann nichts anderes gesendet werden.`,
    },
    queued: 'In der Warteschlange – wird nach den Notizen davor veröffentlicht.',
    dequeue: 'Aus der Warteschlange nehmen',
    rowQueued: 'in der Warteschlange',
    problemsCount: (count) => `Was die Prüfungen gefunden haben (${count})`,
    overrides: {
      fold: 'Einordnung der Kopie ändern',
      hint: (peer) =>
        `Hier eingetragene Felder ersetzen in der Kopie auf ${peer} die Werte der Notiz; null entfernt ein Feld. Leer lassen, um die Werte der Notiz zu behalten.`,
      label: 'Überschreibungen (YAML)',
      save: 'Speichern',
      notMap: 'Ein „Feld: Wert“ pro Zeile',
      invalid: (message) => `Kein gültiges YAML: ${message}`,
      loadFailed: 'Der YAML-Editor konnte nicht geladen werden',
    },
    overview: {
      link: (count) => (count === null ? 'Alle synchronisierten Notizen' : `Alle synchronisierten Notizen (${count})`),
      title: (peer) => `Mit ${peer} synchronisierte Notizen`,
      back: '← Diese Notiz',
      empty: 'Noch nichts synchronisiert',
      missing: 'hier nicht mehr vorhanden',
      publish: 'Veröffentlichen',
      publishAll: (count) => `Alle veralteten veröffentlichen (${count})`,
      progress: (title, line) => `${title}: ${line}`,
      done: (accepted, pending, failed) =>
        [
          `${accepted} synchronisiert`,
          pending ? `${pending} werden noch geprüft` : '',
          failed ? `${failed} nicht synchronisiert` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      loadFailed: 'Die synchronisierten Notizen konnten nicht geladen werden',
    },
    copy: {
      chip: (wiki) => `Kopie · aus ${wiki}`,
      notice: (wiki) =>
        `Diese Notiz ist eine Kopie aus ${wiki}. Bearbeite sie dort – Änderungen hier würden beim nächsten Synchronisieren überschrieben.`,
      revision: 'Revision',
    },
  },
};

/** every table, by language */
export const STRINGS: Record<UiLocale, Strings> = { en, zh, de };

/** The active string table. */
export const S: Strings = STRINGS[uiLocale];

/** a failure in the page's language */
export function failureText(f: WikiFailure): string {
  return wordFailure(S.errors, f);
}

/** a stream's error event in the page's language: its code when this
 *  client knows it, its English line otherwise */
export function eventText(event: { message: string; code?: unknown; params?: unknown }): string {
  return isWikiFailure(event) ? failureText(event as WikiFailure) : event.message;
}

/** a claude job's error event in the page's language — an edit job's
 *  failure says that nothing was written */
export function jobErrorText(event: { message: string; code?: unknown; params?: unknown; unchanged?: boolean | undefined }): string {
  const text = eventText(event);
  return event.unchanged ? `${text} — ${S.ai.unchanged}` : text;
}

/** what went wrong, in the page's language: a server failure by its code
 *  (else its HTTP status), or the line of an error this client raised */
export function errorText(err: unknown, fallback: string = S.common.requestFailed): string {
  if (err instanceof ApiError) return err.failure ? failureText(err.failure) : S.common.http(err.status);
  return err instanceof Error && err.message ? err.message : fallback;
}
