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
import type { WikiUser } from '../shared/types';

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
    intro: 'Publish a password-gated static snapshot of this note.',
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
    intro: '发布本篇的密码门控静态快照。',
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
  },
};

/** The active string table. */
export const S: Strings = uiLocale === 'zh' ? zh : en;
