# Inkbrush 使用手册

[English](manual.md) | **简体中文**

[astro-inkbrush](../README.zh-CN.md) 的部署与使用参考——每个功能怎么用、每个
配置项什么意思、登录方式怎么配、分享网关的接口契约、生产部署的正确姿势。
定位与三处接入见 [README](../README.zh-CN.md)。

- [快速开始](#快速开始)
- [功能导览](#功能导览)
- [界面语言](#界面语言)
- [配置](#配置inkbrushconfigts)
- [登录方式与会话](#登录方式与会话)
- [身份注册表与成员管理](#身份注册表与成员管理)
- [分享与网关契约](#分享与网关契约)
- [双链](#双链)
- [API 参考](#api-参考apiwiki)
- [架构与磁盘状态](#架构与磁盘状态)
- [生产部署](#生产部署)

## 快速开始

```bash
WIKI=1 astro dev      # 编辑模式——CMS 激活
astro build           # 阅读模式——产物与从未装过本包的站点逐字节一致
```

打开任意笔记页,从账号 chip 登录(右上角,或站点摆放的
`[data-inkbrush-slot="account"]` 槽位)。没有配置文件时,唯一的登录方式是
**本地快速登录**(任意昵称+邮箱,无口令)——本机用合适,对外可达的部署绝不能开。

开哪些功能(登录方式、Obsidian 收件箱、autocommit……)由站点根的
`inkbrush.config.ts` 按机器决定,见[配置](#配置inkbrushconfigts)。

CMS 对你的 Markdown 管线的了解来自集成调用本身。只写 `inkbrush()` 时它只用
方言渲染;把站点自己的插件和「笔记 id → URL」规则传进去,编辑器预览、保存
校验和 AI 关卡就会和你的页面渲染得一模一样:

```ts
integrations: [inkbrush({
  markdown: { remarkPlugins, rehypePlugins, urlFor: (id) => `/notes/${id}/` },
})],
```

站点若还给 `markdownProcessor` 传了守门(guard)或 remark-rehype 选项,
把同样的值也传进来(`markdown.guard`、`markdown.remarkRehype`),保存关卡
就跑同一套。

集成只在 `astro dev` 下运行;其他命令下只打一行警告、什么都不做。WIKI 模式
还会关掉 Astro 的 dev 工具条(编辑者不需要开发仪表),但保留错误浮层——
内容写坏时,它就是编辑者的报错界面。

## 功能导览

### 原地块编辑(✎)

悬停任意块,点 ✎:渲染好的块原地换成 CodeMirror 编辑器,直接改这个块的 MDX
源码;服务端实时渲染预览(350 毫秒去抖;JSX 组件块没有独立预览,会明说)、
`[[` 自动补全、⌘/Ctrl+Enter 保存、Esc 取消。每次保存过两道关:

- **乐观锁**——编辑请求带着块内容的哈希;期间别人改过就拒绝保存(409),
  提示刷新重试。
- **整文件 MDX 编译**——服务端把整篇笔记连同这次改动完整编译一遍;语法错误
  直接拒绝(422),坏文件根本落不了盘。

保存成功后 Astro 内容热更新自动刷新页面,滚动位置原地保留。

**页面元信息(frontmatter)** 同样就地改:rehype-wiki-blocks 把它锚到布局里
标了 `[data-inkbrush-slot="frontmatter"]` 的那个元素——页头、元信息条,凡是
从 frontmatter 渲染标题、描述、标签的地方——悬停它就出现 ✎,改的是整个
YAML 块。槽位是必需的(没标就没有这个块:从页面上猜一个标题,很可能本身
已是正文块)。YAML 没有预览(保存后页头随页面重绘),保存关卡要求它能解析。
这里不提供 ✦。

### AI 协作(✦)

需要跑 dev server 的机器上装有 [`claude` CLI](https://claude.com/claude-code)
(可经 `claude.bin` / `claude.model` 配置)。三个入口,进度全部实时流式展示:

- **改一个块**——悬停 ✦,选快捷指令(润色 / 更严谨 / 精简 / 修公式)或自己
  写要求;Claude 在笔记的工作副本里改这个块,结果和人工保存一样先过校验、
  再入修订账。任务在服务端执行,关掉页面也照跑。超时 300 秒。
- **就笔记提问**——右下角浮钮拉出对话面板;Claude 在工作副本里读源文件作答,
  数学照常渲染。追问延续同一场对话,刷新页面不丢。超时 300 秒。
- **整篇翻译**——[语言表](#contentlocales)里每种还没有的语言各一个按钮。
  不是逐句直译:提示词让 Claude 以作者身份用目标语言重写整篇,并守死一串
  不变量(锚点、公式结构、代码逻辑、组件 props 不动;人读的文字都翻译——
  包括公式里的文字)。目标语言已存在时拒绝(409)。超时 30 分钟。

每个任务都在一份**临时工作副本**里跑:一个临时目录,只装这篇笔记所在目录的
拷贝,外加 `claude.companions` 为这篇笔记点名的文件(比如它挂载的 demo 模块)。
CLI 的工作目录就是这份副本,文件工具被权限规则限制在副本内(编辑类任务
`Read`、`Edit`、`Write`、`MultiEdit` 只对 `./**`;问答只有 `Read`),
`Bash`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`NotebookEdit` 和子代理一律
禁用,环境变量按白名单给——部署密钥到不了子进程。任务结束后把副本和开工时
的快照做对比;每个改动过的 Markdown 文件都要过和人工保存相同的构建关
(方言、守门、你的插件、MDX),而任务进行中被人手工改过的文件会让整批改动
作废——手工编辑永远赢。全过了才把改动(伴随文件也在内)写进项目、入账、
并在开了 `autocommit` 时提交。站点自己的写作规范通过 `claude.rules` 进入
每一条提示词。

### 修订史与回滚(⟲)

每次内容变更——人工、Claude、翻译、收件箱导入、回滚——都往账本里追加一条
带唯一 id 的记录(谁、何时、哪些行、改前改后、经何途径)。⟲ 列出当前块的
记录(按行号重叠或内容精确匹配找回),带可展开的改前/改后对照和一键回滚;
要撤销的内容已不在记录的位置(被后续修改覆盖,或同样文字出现在多处、
无法唯一定位)时拒绝(409),不瞎猜。整文件的记录——导入、翻译、AI 的
伴随文件改动——列为只读的审计行:撤销它们是 git 的活。

### 评论区

每篇笔记页尾的评论区(挂进 `[data-inkbrush-slot="comments"]`,没有槽位则
回退找 `.note-main .col` 容器)。Markdown + `$…$` 数学 + 代码块;服务端过
消毒器渲染(GitHub 规则集,外加数学类名;评论渲染数学但不解析双链——
评论不能凭空铸造站内链接);单条上限一万字;
只能删自己的评论。以 NDJSON 平文件存放——没有数据库。

### Obsidian 收件箱

把 `inbox.dir` 指向 vault 里的一个文件夹,**新增**的笔记就会自动转换导入到
`<content.dir>/inbox/<YYYY-MM-DD>-<哈希>/`(日期取 `YYYY-MM-DD` 形式的父目录
名,其次 frontmatter 的 `saved`,再次当天)。监听启动时已经存在的文件只标记
不导入——要补导就调 `POST /api/wiki/inbox/import {path}`。源文件内容变了会
重新导入到同一个地址。转换规则:

- `![[图片|说明]]` 嵌入:先在笔记的 `_assets/<笔记名>/` 找,再 `_assets/`,
  再笔记同目录;找到的文件**复制到导入后的笔记目录里**——删笔记目录就删干净
  它名下的一切。找不到的嵌入变成明晃晃的 `*[missing attachment: …]*` 标记。
- 能解析到站内笔记的 `[[双链]]` 保持为真链接;其余压平成斜体。
- `==高亮==` → `<mark>`;单行 `$$x$$` 展示数学规整成三行形式。
- Obsidian 剪藏的 frontmatter(`author` / `source` / `url` / `saved`)变成
  一行 `> Source: …`;描述从第一段实质内容自动提取。

`inbox.ignore` 用来跳过噪音:每一项按 vault 相对路径前缀和文件名前缀匹配,
命中任意一个就跳过——`['daily/']` 跳过整个文件夹,`['scratch-']` 按名字跳过文件。

### 对外分享

把单篇笔记发布成**密码门控的静态快照**,托管在你自己架的网关上——见
[分享与网关契约](#分享与网关契约)。

### 账号 chip

显示登录者(身份注册表开启时含角色)、列出可用的登录方式、给管理员提供
成员管理面板。站点 chrome 里有 `[data-inkbrush-slot="account"]` 槽位就入槽,
没有就固定浮在右上角(`--wiki-chip-top` / `--wiki-chip-right` 微调)。
块把手的视口定位会避让 `[data-inkbrush-sticky]` 标记的吸顶元素
(回退找 `.site-nav`),不会藏到你的吸顶导航条底下。

## 界面语言

CMS 界面内置英文与中文,按站点自己的 `<html lang>` 逐页选择:`zh` 开头用
中文,其余用英文。刻意不设配置开关——站点本来就声明了自己的语言。日期格式
跟随同一选择。服务端报错信息为英文。

## 配置(`inkbrush.config.ts`)

一台部署机器一份,放站点根,已 git-ignore(模板
`inkbrush.config.example.ts`;类型 `astro-inkbrush/config`)。**没有配置文件
也完全可用**:默认只开本地登录,其余全关。

```ts
import { defineInkbrushConfig } from 'astro-inkbrush/config';

export default defineInkbrushConfig({
  auth: {
    dev: true,                    // 对外可达的部署绝不能开
    google: false,                // 或 { allowedDomains: ['acme.com'], baseUrl: 'https://…' }
    // googleSaml: { entryPoint, idpEntityId, certFile, allowedDomains?, baseUrl },
    // session: { format?, cookieName?, cookieDomain?, ttlDays?, trustedOrigins? },
  },
  // identity: { dir: '.wiki/identity', roles?, defaultRole?, adminRole?, autoRegister? },
  inbox: { dir: '~/vault/收件箱', ignore: ['daily/'] },   // 省略 dir = 不监听
  autocommit: false,
  autopush: false,
  // claude: { bin: 'claude', model: '…', companions?: (note) => [...], rules?: [...] },
  // content: { dir: 'src/content/notes', locales: [...] },
  // share: { gatewayUrl: 'http://gateway.internal:8787', publicBase: 'https://share.example.com' },
});
```

| 配置项 | 默认 | 作用 |
|---|---|---|
| `auth.dev` | `true`(只服务本机) | 昵称+邮箱即时登录。默认只服务回环地址;显式 `true` 才对所有客户端开放——对外可达的部署绝不能开 |
| `auth.google` | 关 | Google OAuth——[配置步骤](#google-oauth) |
| `auth.googleSaml` | 关 | Google Workspace SAML SSO——[配置步骤](#google-workspace-saml-sso) |
| `auth.session` | hmac 默认值 | 会话 cookie 行为——[会话](#会话)一节 |
| `identity` | 关 | 文件式成员注册表——[身份注册表](#身份注册表与成员管理) |
| `inbox.dir` | 关 | Obsidian 收件箱监听目录(支持 `~/`) |
| `inbox.ignore` | `[]` | 导入跳过清单(路径/文件名前缀) |
| `autocommit` | `false` | 每次保存后在内容仓自动 git commit(作者 = 登录用户) |
| `autopush` | `false` | 每次 autocommit 后异步 git push——部署机开启 |
| `claude.bin` / `claude.model` | `'claude'` / CLI 自身默认 | AI 端点用哪个 CLI / 哪个模型 |
| `claude.companions` | 无 | `(note) => string[]`——笔记目录之外,任务还可以读写的项目相对路径(文件或目录) |
| `claude.rules` | `[]` | 站点自己的写作规范,追加在方言规则之后进入每条提示词 |
| `content.dir` | `'src/content/notes'` | 笔记内容根目录(相对站点根) |
| `content.locales` | zh/en/de 表 | 笔记语言表——[见下](#contentlocales) |
| `share` | 关 | 快照分享——[分享](#分享与网关契约)一节 |
| `server.trustProxy` | `false` | 推导本服务自身 origin 时是否采信 `x-forwarded-host`/`-proto`——有反代在前面就开,否则别开 |

配置在启动时校验:cookie 名/域不合法、`trustedOrigins` 不是纯 origin、
登录或网关地址不是 http(s)、`content.dir` 是绝对路径、只开 `autopush` 不开
`autocommit`,都会拒绝启动并点名字段。

改动配置文件后,下一次请求即生效(服务端热更)——唯独收件箱监听目录是
dev server 启动时创建的,改它要重启。

所有可选功能遵循同一套三态:**关**(配置里省略——路由 404,按钮压根不
渲染)、**就绪**(可用)、**未配全**(配置里开了但缺 env/证书——按钮置灰,
路由返回 503)。接口留好,绝不半死不活。

### `content.locales`

笔记语言表决定语言识别、语言切换按钮和 AI 翻译的目标语言。笔记 id 用路径
前缀标语言;**必须恰好有一条 `prefix: ''`**——那是默认语言,它的笔记不带
前缀、直接放内容根。code 与 prefix 都不得重复,非空 prefix 只能是单个路径段
(`en/`),否则拒绝启动。默认表:

```ts
locales: [
  { code: 'zh', prefix: '',    label: '中文',    promptName: '中文' },
  { code: 'en', prefix: 'en/', label: 'English', promptName: 'English', appendixTitle: 'Appendix' },
  { code: 'de', prefix: 'de/', label: 'Deutsch', promptName: 'Deutsch（德语）', appendixTitle: 'Anhang' },
]
```

`label` 是语言切换按钮上的显示名,`promptName` 是翻译提示词里对这种语言的
称呼,`appendixTitle` 是译文附录部分的标题(默认 `'Appendix'`)。前缀必须是
`''` 或以 `/` 结尾;重复、或默认语言不是恰好一条,启动时直接报错——这里出错
的代价是笔记被静默归错位置,所以宁可吵。

### 环境变量覆盖

环境变量对配置做**单次运行**的临时覆盖(配置文件才是常驻真源):

| 变量 | 覆盖 |
|---|---|
| `WIKI` | `1` 开启 wiki 模式(仅 dev;必需;无配置文件对应项) |
| `WIKI_DEV_LOGIN` | `auth.dev`(`0`/`1`) |
| `WIKI_ALLOWED_DOMAIN` | `auth.google.allowedDomains`(逗号分隔) |
| `WIKI_BASE_URL` | `auth.google.baseUrl` / `auth.googleSaml.baseUrl` |
| `WIKI_SAML_SSO_URL` | `auth.googleSaml.entryPoint` |
| `WIKI_SAML_IDP_ENTITY_ID` | `auth.googleSaml.idpEntityId` |
| `WIKI_SAML_CERT_FILE` | `auth.googleSaml.certFile` |
| `WIKI_SAML_ALLOWED_DOMAIN` | `auth.googleSaml.allowedDomains`(逗号分隔) |
| `WIKI_SESSION_FORMAT` | `auth.session.format`(`hmac`/`jwt`) |
| `WIKI_COOKIE_NAME` | `auth.session.cookieName` |
| `WIKI_COOKIE_DOMAIN` | `auth.session.cookieDomain` |
| `WIKI_SESSION_TTL_DAYS` | `auth.session.ttlDays` |
| `WIKI_TRUSTED_ORIGINS` | `auth.session.trustedOrigins`(逗号分隔) |
| `WIKI_IDENTITY_DIR` | `identity.dir`(设置即启用 identity 模块) |
| `WIKI_INBOX_DIR` | `inbox.dir`(设为空字符串 = 本次运行不监听) |
| `WIKI_INBOX_IGNORE` | `inbox.ignore`(逗号分隔) |
| `WIKI_AUTOCOMMIT` / `WIKI_AUTOPUSH` | `autocommit` / `autopush`(`0`/`1`) |
| `WIKI_TRUST_PROXY` | `server.trustProxy`(`0`/`1`) |
| `WIKI_CLAUDE_BIN` / `WIKI_CLAUDE_MODEL` | `claude.bin` / `claude.model` |
| `WIKI_SHARE_GATEWAY_URL` / `WIKI_SHARE_PUBLIC_BASE` | `share.gatewayUrl` / `share.publicBase` |

`content.dir` 与 `content.locales` 没有环境变量覆盖——它们是配置文件级的
决定。功能的**启用**也永远由配置文件决定,环境变量只能覆盖已启用功能的字段。

**密钥只走环境变量,绝不进配置文件**:`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`(OAuth)、`AUTH_SECRET`(jwt 会话——缺失启动即报错)、
`ADMIN_EMAILS`(身份注册表播种)、`SHARE_GATEWAY_TOKEN`(网关 admin token)。

## 登录方式与会话

### 本地快速登录(默认只服务本机)

昵称+邮箱,无口令,即刻拿到会话。默认(没有配置文件、或没写 `auth.dev`)
**只服务本机回环地址**——`--host` 起的 dev server 会拒掉别的机器的快速登录。
显式写 `auth.dev: true` 才对所有可达客户端开放:只适合可信内网,对外可达的
部署绝不能开。

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → 创建 OAuth 2.0 Client ID(Web application)。
2. Authorized redirect URI 填
   `<auth.google.baseUrl>/api/wiki/auth/google/callback`
   (本机测试就是 `http://localhost:4321/api/wiki/auth/google/callback`)。
3. 配置里开启 `auth.google`,启动时带上密钥:
   ```bash
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… WIKI=1 astro dev
   ```

id token 经 Google tokeninfo 端点验签(校 audience 与邮箱已验证),再过
`allowedDomains` 白名单——**默认拒绝**:空名单谁都进不来;要明确放行所有
Google 账号就写 `['*']`。名单项可以是域名(`acme.com`)也可以是完整地址
(`bob@gmail.com`)。登录 state 带签名、绑定发起登录的浏览器、只能用一次,
10 分钟过期——重放或过期的回调在服务端就会失败。

### Google Workspace SAML SSO

OAuth 之外的第二条 Workspace 通道,适合"一个 IdP 应用、多个站点共享会话"
(搭配 jwt 会话 + 共享 cookie 域):

1. Google Admin console → Apps → Web and mobile apps → 添加**自定义 SAML
   应用**。记下 **SSO URL**(`entryPoint`)与 **Entity ID**(`idpEntityId`),
   下载证书、`certFile` 指向它——三种形态都认:完整多行 PEM、纯 base64 正文、
   或整个 `base64 -w0 cert.pem` 的产物。路径支持 `~/` 与相对站点根。
2. 应用的 SP 侧填:ACS URL = `<baseUrl>/api/wiki/auth/saml/callback`、
   Entity ID = `<baseUrl>/api/wiki/auth/saml/metadata`(Name ID = 邮箱)。
   要核对就直接打开 `GET /api/wiki/auth/saml/metadata`——证书还没配好时
   SP 元数据 XML 也能输出。
3. 配置开启 `auth.googleSaml: { entryPoint, idpEntityId, certFile,
   allowedDomains?, baseUrl }`。

登录流:`GET /auth/saml/login?return=…` 跳到 Google → Google 把断言 POST 回
ACS(验签、邮箱域过白名单、身份注册表开启时自动登记新用户)→ 303 回
`return`。相对路径的 return 恒放行;站外 origin 必须列入
`session.trustedOrigins`。**ACS 永不 500**——一切失败都优雅降级为
`303 /?login_error=<code>`,code 为 `saml_config` / `saml_disabled` /
`saml_response` / `saml_invalid` / `wrong_domain` / `not_member` /
`saml_error` 之一。`allowedDomains` 和 OAuth 一样默认拒绝:空表谁也进不来,
`['*']` 才是明说的全放行。

### 会话

两种格式;省略配置即 hmac 默认值(`wiki_session`、host-only cookie、30 天):

- **`hmac`**——用每站生成的密钥(`.wiki/secret`,首次运行生成,权限 0600)
  签名的 cookie。单站部署用它。
- **`jwt`**——HS256,密钥走 `AUTH_SECRET` 环境变量(缺失启动即报错)。配上
  `cookieDomain: '.example.com'` 即得跨子域 SSO:同域名下的姊妹应用可以
  验证同一枚 cookie。默认有效期 7 天(`ttlDays` 可改)。

角色永不写进 token——注册表每个请求现查,改角色、移人立即生效。登录回跳
地址(`?return=`、OAuth `state`、SAML RelayState)有开放重定向防护:相对
路径恒放行,`//`、`/\` 与控制字符恒拦截,站外 origin 必须在
`trustedOrigins` 里。

## 身份注册表与成员管理

`identity: { dir }` 启用文件式注册表:`<dir>/users.json`,纯 JSON
`[{ email, name, role }]`,可与同机的其他应用共享同一份。角色词汇表、SSO
首登的默认角色、管理员角色名全部可配(`roles` / `defaultRole` /
`adminRole`)。注册表开启期间,**所有需登录的路由都要求当前在册**——用户被
从名单里删掉后,其会话的下一个请求就会被拒(403)。

- `users.json` 还不存在时,用 `ADMIN_EMAILS` 环境变量(逗号分隔)播种管理员;
  一个管理员都没有时服务端拒绝启动注册表。
- `autoRegister`(默认 `true`)允许白名单域名下的首次 SSO 登录以
  `defaultRole` 入册;设为 `false` 则注册表变成只有管理员能扩的白名单——
  陌生用户被送回 `?login_error=not_member`。
- 管理员在账号弹层的 **Members** 面板增删成员、改角色;服务端校验词汇表,
  并强制至少保留一名管理员。
- 写入是原子的(临时文件 + 改名);文件损坏时拒绝服务,绝不装作"注册表为空"。

## 分享与网关契约

配好 `share` 后,`[data-inkbrush-slot="share"]` 槽位出现 **Share** 按钮
(站点必须提供槽位——没有槽位就没有按钮),登录用户即可把当前笔记发布为
密码门控的静态快照:

1. **创建**——弹层预生成 10 位密码(可改;最少 6 位),有效期 7 天 / 30 天 /
   永久三选一。服务端用站点自己装的 astro、白名单环境变量、10 分钟上限跑一次
   **WIKI-free 的 `astro build`**(缓存在
   `.wiki/share-dist`;冷构建要几分钟,进度实时流式回传),抽出该路由的
   `index.html` 与完整资源闭包(HTML 属性 → CSS `url()`/`@import` → JS
   import 图),引用改写成 `./` 相对、注入 `noindex`,打成 tar.gz PUT 给
   网关。分享 id 是 10 位 base58——不含 `0/O/I/l`,念出来不会错。
2. **密码**——从作者浏览器发到编辑机一次,在编辑机上 scrypt 哈希,发给网关的
   只有哈希;明文在哪里都不落盘,仅创建成功时显示一次。一篇笔记同时只有
   一个活跃分享:已有活跃分享时再创建会被拒(409)并回给现有链接。
3. **撤销**——删掉网关上的目录,链接立刻 404。本地记录(含 `revokedAt`)
   保留在 `.wiki/data/shares.json` 作审计。

收件人打开 `<publicBase>/s/<id>/`,输密码,阅读。

### 网关 admin API(自己实现一个)

网关是一纸契约,不是捆绑服务——任何实现了这套小小的 Bearer 鉴权 admin API
的静态托管都行(nginx + 目录树前面一个小应用,一下午的活):

| 调用 | 含义 |
|---|---|
| `GET /admin/s` | 健康/鉴权预检;引擎在昂贵的构建之前先打它(5 秒超时)。401 = token 不对 |
| `PUT /admin/s/<id>` | 创建/替换快照 `<id>`。请求体 = tar.gz,`index.html` 在包根——解压到你以 `/s/<id>/` 提供服务的目录即可 |
| `DELETE /admin/s/<id>` | 删除快照 `<id>`(这里的 404 视为本来就没有) |

PUT 的请求头:

| 头 | 内容 |
|---|---|
| `authorization` | `Bearer <SHARE_GATEWAY_TOKEN>` |
| `x-share-password` | `scrypt$N$r$p$<salt-b64url>$<hash-b64url>`——N=2¹⁵、r=8、p=1、32 字节哈希。校验访客密码时按内嵌参数重算比对 |
| `x-share-expires` | 可选的 ISO-8601 时间戳;过期后应答 404/410 |
| `x-share-note` | 来源笔记 id(含非 ASCII 时 URI 编码)——仅供参考 |

网关的公开侧再把 `GET /s/<id>/…` 挡在密码框后面,与存储的哈希比对。网关
永远见不到明文密码,也不需要账号体系。

## 双链

`[[目标]]`、`[[目标|显示文字]]`、`[[目标#锚点]]`——笔记与编辑器预览里可用,
编辑器里有 `[[` 自动补全(评论渲染数学但不解析双链)。`![[嵌入]]`、引用
惯用法 `[[1]](#ref)` 与转义写法 `\[[x]]` 刻意不算双链。解析顺序:

1. **来源笔记的语言镜像优先**——`en/` 笔记里的 `[[X]]`,若 `en/X` 存在则
   解析到它;
2. **精确 id**(包括显式写前缀的 `[[en/X]]`);
3. **别名 / 品牌名 / 标题**,不分大小写——多篇命中 = *有歧义*。

id 匹配区分大小写,别名/标题回退不区分。解析不到永远不弄红构建:渲染成
`span.wikilink-dead`(tooltip 说明是查无此篇还是有歧义),同时触发站点的
`onBroken` 钩子供 lint 用。

## API 参考(`/api/wiki/*`)

鉴权列:公开 · 需登录 · 管理员(管理员 = 身份注册表开启且调用者的注册角色
等于 `adminRole`;模块关闭时这些路由 404)。

| 方法与路径 | 鉴权 | 行为 |
|---|---|---|
| `GET /me` | 公开 | 会话 + 各登录方式可用性 + 分享状态(注册表开启时含 `role`) |
| `POST /auth/dev` | 公开 | `{name,email}` → 会话 cookie;本地登录关闭时 403 |
| `GET /auth/google` | 公开 | 302 到 Google 授权页(`?return=` 经 `state` 携带) |
| `GET /auth/google/callback` | 公开 | code → 验签 → cookie → 302 回跳 |
| `GET /auth/saml/login` | 公开 | 302 到 IdP(`?return=` 作 RelayState) |
| `POST /auth/saml/callback` | 公开 | ACS;永不 500——失败一律 303 到 `/?login_error=<code>` |
| `GET /auth/saml/metadata` | 公开 | SP 元数据 XML(证书未配也能输出) |
| `POST /logout` | 公开 | 清除会话 cookie |
| `GET /meta/<id>` | 公开 | 笔记元数据:文件、标题、`locales`(各语言存在与否) |
| `GET /notes` | 公开 | 轻量笔记清单(自动补全与链接解析用) |
| `GET /block/<id>?start&end` | 需登录 | 读块源码 `{source, hash, start, end}`(400/416) |
| `PUT /block/<id>` | 需登录 | 写块 `{start,end,hash,source}`(409 锁冲突 / 422 构建错误);开 autocommit 时提交失败会回 `{ok:true, git:'failed'}` |
| `POST /render` | 需登录 | `{markdown, sanitize?, note?}` → HTML(默认消毒;受信路径解析双链) |
| `GET /revisions/<id>` | 需登录 | 该笔记的修订记录(最近 100 条) |
| `POST /revert/<id>` | 需登录 | `{id}` → 回滚该条块级修订(404/400/409/422;整文件记录 400) |
| `POST /claude/block` | 需登录 | NDJSON 流;300 秒上限;关页面照跑 |
| `POST /claude/ask` | 需登录 | NDJSON 流;300 秒上限;断连即杀;可续对话——但只有开启该会话的同一用户、同一笔记能续(否则 403;会话表在内存里,服务重启即清) |
| `POST /claude/translate` | 需登录 | NDJSON 流;30 分钟上限;目标语言已存在时 409 |
| `GET /inbox/status` | 需登录 | `{enabled, watching, seen, imported}` |
| `POST /inbox/import` | 需登录 | `{path}` 补导;路径锁定在 `inbox.dir` 内 |
| `GET /comments/<id>` | 公开 | 现存评论(删除已生效);作者只露 `{name, provider}`——邮箱永不出服务端;`canDelete` 按请求者计算 |
| `POST /comments/<id>` | 需登录 | 发评论(超一万字 413) |
| `DELETE /comments/<id>?cid=` | 需登录 | 只能删自己的(否则 403) |
| `GET /identity/users` | 管理员 | 成员表 + 角色词汇表 |
| `PUT /identity/users` | 管理员 | 全表覆盖写(校验;保护最后一名管理员) |
| `POST /share` | 需登录 | 创建分享——NDJSON 流:`progress…` → `result`;该笔记已有活跃分享时 409 |
| `GET /share?note=<id>` | 需登录 | 该笔记的活跃分享(note 参数必填);每条记录带按请求者算的 `canRevoke` |
| `DELETE /share/<id>` | 需登录 | 撤销——只有创建者本人,或注册表开启时的管理员(否则 403) |

AI 任务每用户最多同时 2 个、全机最多 4 个(超出 429);排队中的任务不占
名额。每类任务还有形状约束:块编辑不得改动笔记里选中块之外的任何内容
(伴随文件不受限),翻译除目标文件外什么都不能动——违反约束的结果整体作废。

通用规则:JSON 请求体必须以 `application/json` 发送、上限 1 MiB(否则
415/413);改状态的请求若 `Origin`(或 `Referer`)指向本站和 `trustedOrigins`
之外的站点,一律 403——浏览器跨站表单必带 Origin,cookie 因此无法被别的
网页盗用(两个头都没有的是非浏览器客户端,放行);SAML ACS 例外——它的
鉴权是签名断言本身;
预期内的 4xx 返回 `{error}` JSON,意外失败返回带参考 id 的 500,服务端日志里
能按 id 找到。

## 架构与磁盘状态

```
astro.config.ts ──WIKI=1──▶ inkbrush() 集成   (src/wiki/integration.ts)
   ├─ injectScript('page') → src/wiki/client/*   (把手/编辑器/AI/评论/分享界面;
   │                                              strings.ts = en/zh 字符串表)
   ├─ dev 中间件 /api/wiki/* → src/wiki/server/*   (ssrLoadModule——服务端代码
   │                                               也热更)
   └─ initWiki(root, { markdown }) → 注册表检查、站点 Markdown 钩子、
                                     收件箱监听器

src/lib/        与管线无关的库:markdown-syntax(方言)、markdown(处理器
                一行接入)、content-guard、rehype-wiki-blocks(块↔源码行号)、
                wikilinks
src/wiki/shared/  跨界类型 + locales.ts(语言注册表 + resolveLocales)
scripts/        check-content.mjs / check-wikilinks.mjs / check-dist.mjs——独立检查 CLI
```

编辑 = 改写 `<content.dir>` 下的源文件;Astro 内容热更新刷新页面。**文件即
数据库,git 即历史**——修订账本在其上再加一层块级审计。全部 CMS 状态住在
站点根的 `.wiki/`(git-ignored):

`.wiki/` 目录以 0700 创建、文件 0600——账本、评论与身份记录里有邮箱和角色。

```
.wiki/
  secret                    会话 HMAC 密钥(首次运行生成,0600)
  data/comments/<id>.ndjson 追加式评论(笔记 id 经 URL 编码)
  data/revisions.ndjson     修订账本
  data/inbox-sync.json      收件箱监听状态(内容哈希)
  data/shares.json          分享记录(含已撤销的,作审计)
  share-dist/               快照用的 WIKI-free 构建缓存
```

信任模型,直说:**入册即托付代码。**笔记是 Markdown/MDX——成员写的组件、
表达式、原生 HTML,站点构建和编辑器预览都会在与 CMS 同源的页面上执行。
这是 MDX wiki 的本性:把一个人加进注册表,就等于像信任提交者一样信任
此人,对管理员也一样。CMS 的权限分层(成员/管理员、分享创建者)管的是
它的 API,不管渲染后的内容能做什么。注册表保持短小、都是活人。

安全姿态:Claude 任务在临时工作副本里跑,文件工具限制在副本内、没有 shell
与网络工具,产出先过构建关再写入;评论 HTML 服务端消毒;笔记、附件、收件箱
的每个路径都解析到真实位置,必须留在 `content.dir` / `inbox.dir` 之内;写入
原子且进程内串行;OAuth 用 PKCE 加绑定浏览器的一次性 state,SAML 只接受
对本服务所发请求的响应;域名白名单默认拒绝;回跳地址有开放重定向防护;jwt
模式缺密钥拒绝启动;成员资格与角色每请求现查;来自外站 `Origin` 的
改动请求一律拒绝;请求体有上限。

## 生产部署

定案的形态是**读编分离**:「改完即生效」需要编译器常驻,而 Astro 的常驻
编译器形态就是 dev server——所以编辑机把它当成品来跑,读者永远碰不到它:

- **读者只见 `astro build` 产物**(nginx、对象存储、Pages……)。不开 WIKI
  的构建与纯静态基线逐字节一致——读者面上没有任何 dev 或 CMS 痕迹。
- **编辑机是授权写入面**:专属子域(不要挂在读者站的路径前缀下——dev
  server 的虚拟模块 URL 是根相对的,挂前缀必坏)、反代 TLS、
  `auth.dev: false` 换真实登录方式、内容检出放持久卷,`autocommit` +
  `autopush` 把每次保存送回内容仓,再由 CI 重建读者站。
- 一个 dev server 进程服务一个编辑团队:对同一篇笔记的写入在进程内按文件
  串行,同一块的并发保存会被 409 拒绝而不是覆盖;进程之间没有协调——每个
  内容仓只跑一个实例。

典型配法:

| | `auth.dev` | 登录方式 | `inbox.dir` |
|---|---|---|---|
| 个人本机 / 内网 | `true` | — | 你的 vault |
| 团队内网 wiki | `false` | Google OAuth 或 SAML | 视需要 |
| 公网静态站 + 私有编辑机 | `false` | 视需要 | 视需要 |

双服务骨架(静态读者站 + 编辑机:Dockerfile、compose 示例、一个负责克隆或
更新检出、安装本机配置与凭据并启动服务的 entrypoint)在本仓的
[`deploy/`](../deploy/README.md)。
