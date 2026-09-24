/**
 * UI strings — the single i18n layer for the wiki chrome.
 *
 * Locale is resolved once at module load from the host page:
 * `<html lang="zh…">` → zh, anything else → en. The CMS deliberately keys
 * off the site's own declared language instead of adding a config knob —
 * the editing UI should match the page it is editing.
 *
 * Both tables implement the same `Strings` interface, so a missing key in
 * either locale is a type error. Strings that interpolate data are functions.
 * Server responses (errors, Claude tool labels) arrive in English; the zh
 * table remaps the well-known tool verbs and passes everything else through.
 */
import type { SyndicationErrorCode, SyndicationStage, SyndicationWarning, WikiUser } from '../shared/types';
import type { Standing } from './syndication';
import type { Action, Outcome } from './syndication-state';

export type UiLocale = 'en' | 'zh';

export const uiLocale: UiLocale = document.documentElement.lang.toLowerCase().startsWith('zh')
  ? 'zh'
  : 'en';

/** BCP 47 tag for Intl formatting. */
export const dateLocale = uiLocale === 'zh' ? 'zh-CN' : 'en-GB';

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

interface Strings {
  common: {
    requestFailed: string;
    /** Claude tool-activity labels stream from the server in English;
     *  zh remaps the known verbs and passes the path through. */
    tool: (label: string) => string;
  };
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
  };
  identity: {
    title: string;
    colEmail: string;
    colName: string;
    colRole: string;
    colActions: string;
    namePlaceholder: string;
    emailPlaceholder: string;
    add: string;
    remove: string;
    removeLabel: (email: string) => string;
    confirmRemove: (email: string) => string;
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
    gatewayUnreachable: (message: string) => string;
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
    /** a failure without a code this client knows, by HTTP status (0: no
     *  answer arrived); `detail` is the server's line, shown for a 422 only */
    http: (status: number, detail: string) => string;
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

const EN_LOGIN_ERRORS: Record<string, string> = {
  saml_config: 'SSO is not configured correctly on this site.',
  saml_disabled: 'SSO sign-in is disabled on this site.',
  saml_response: 'The SSO response was missing or unreadable.',
  saml_invalid: 'The SSO response could not be verified.',
  saml_error: 'SSO sign-in failed.',
  wrong_domain: 'Your account is not in an allowed email domain.',
  not_member: 'Your account is not a member of this site.',
};

const en: Strings = {
  common: {
    requestFailed: 'Request failed',
    tool: (label) => label,
  },
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
    loginError: (code) => EN_LOGIN_ERRORS[code] ?? `Sign-in failed (${code})`,
    provider: {
      dev: 'Local test session',
      google: 'Google Workspace',
      'google-saml': 'Google Workspace SSO',
    },
    noProviders: 'No sign-in method enabled (configure inkbrush.config.ts → auth)',
    role: (role) => `Role: ${role ?? '—'}`,
    members: 'Members',
  },
  identity: {
    title: 'Members',
    colEmail: 'Email',
    colName: 'Name',
    colRole: 'Role',
    colActions: 'Actions',
    namePlaceholder: 'Name',
    emailPlaceholder: 'name@team.com',
    add: 'Add',
    remove: 'Remove',
    removeLabel: (email) => `Remove ${email}`,
    confirmRemove: (email) => `Remove ${email}?`,
    saved: 'Members saved',
    saveFailed: 'Save failed',
    loadFailed: 'Failed to load members',
    emailRequired: 'Valid email required',
    adminNote: (role) => `At least one '${role}' is always kept (server-enforced)`,
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
    gatewayUnreachable: (message) => `Share gateway unreachable: ${message}`,
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
    http: (status, detail) =>
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
                : status === 422
                  ? `This wiki's checks refused it: ${detail}`
                  : status >= 500
                    ? `This wiki's server ran into an error (HTTP ${status}).`
                    : `The request failed (HTTP ${status}).`,
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

const ZH_LOGIN_ERRORS: Record<string, string> = {
  saml_config: '本站的 SSO 配置不正确。',
  saml_disabled: '本站未启用 SSO 登录。',
  saml_response: 'SSO 响应缺失或无法读取。',
  saml_invalid: 'SSO 响应无法通过校验。',
  saml_error: 'SSO 登录失败。',
  wrong_domain: '你的账号不在允许的邮箱域名内。',
  not_member: '你的账号不是本站成员。',
};

const zh: Strings = {
  common: {
    requestFailed: '请求失败',
    tool: (label) => translateTool(label, ZH_TOOL_VERBS),
  },
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
    loginError: (code) => ZH_LOGIN_ERRORS[code] ?? `登录失败（${code}）`,
    provider: {
      dev: '本地测试会话',
      google: 'Google Workspace',
      'google-saml': 'Google Workspace SSO',
    },
    noProviders: '未启用任何登录方式（配置 inkbrush.config.ts → auth）',
    role: (role) => `角色：${role ?? '—'}`,
    members: '成员管理',
  },
  identity: {
    title: '成员管理',
    colEmail: '邮箱',
    colName: '姓名',
    colRole: '角色',
    colActions: '操作',
    namePlaceholder: '姓名',
    emailPlaceholder: 'name@team.com',
    add: '添加',
    remove: '移除',
    removeLabel: (email) => `移除 ${email}`,
    confirmRemove: (email) => `移除 ${email}？`,
    saved: '成员表已保存',
    saveFailed: '保存失败',
    loadFailed: '成员列表加载失败',
    emailRequired: '需要有效邮箱',
    adminNote: (role) => `服务端强制至少保留一名「${role}」`,
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
    gatewayUnreachable: (message) => `分享网关不可达：${message}`,
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
    http: (status, detail) =>
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
                : status === 422
                  ? `本站的检查没通过：${detail}`
                  : status >= 500
                    ? `本站服务器出错了（HTTP ${status}）。`
                    : `请求失败（HTTP ${status}）。`,
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

/** The active string table. */
export const S: Strings = uiLocale === 'zh' ? zh : en;
