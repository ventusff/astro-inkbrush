<h1 align="center">astro-inkbrush</h1>

<p align="center"><b>给 Astro 的极小 git-backed CMS——在页面上原地编辑你的静态站。</b></p>

<p align="center">
  <a href="https://github.com/ventusff/astro-inkbrush/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ventusff/astro-inkbrush/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2b2622"></a>
  <img alt="Astro 7" src="https://img.shields.io/badge/Astro-7-b6552e?logo=astro&logoColor=white">
</p>

<p align="center">
  <a href="https://ventusff.github.io/astro-inkbrush/"><b>在线示范笔记站&nbsp;→</b></a>
  &nbsp;·&nbsp;
  <a href="docs/manual.zh-CN.md">使用手册</a>
  &nbsp;·&nbsp;
  <a href="README.md">English</a>
</p>

<p align="center">
  <img alt="示范笔记站:阅读态,以及同一页面上某个块打开原地编辑器的样子" src=".github/assets/demo-preview.png" width="920">
</p>

**Inkbrush(笔)**给任意 Astro 站点叠加一层可选的编辑能力:鼠标悬到某个段落,
点 ✎,原地改 Markdown 源码,保存——页面热更新,改动即一次 git 提交。没有数据库、
没有管理后台、没有独立的写作应用。内容文件始终是唯一事实源,git 始终是历史。

它与 [**astro-inkstone**](https://github.com/ventusff/astro-inkstone)(砚)是
姊妹项目——一个纸墨质感的设计层。Inkbrush 刻意**不带任何样式与布局**:
接到你自己的站上用,或与 Inkstone 配套获得完整观感。

## 特性

- ✏️ **原地块编辑** —— Wikipedia 式逐块编辑。CodeMirror 6、服务端实时渲染
  预览、`[[` 自动补全、乐观锁,保存前先过整文件 MDX 编译关。
- 🕘 **块级修订史** —— 每次保存入账;逐块查看历史,任意一笔一键回滚。
- 🤖 **AI 协作** —— 改写某个块、就当前笔记提问(助手在服务端直接读源文件)、
  一键生成整篇笔记的另一语言版——经 `claude` CLI,进度实时流式展示,
  工具权限收紧。
- 💬 **评论区** —— Markdown + 数学公式,服务端消毒,以 NDJSON 平文件存放在
  内容旁边。
- 📥 **Obsidian 收件箱** —— 监听 vault 目录;新笔记自动转换导入
  (附件解析并随笔记同目录存放、双链改写、高亮保留)。
- 🔗 **双链** —— 一份 `[[wikilink]]` 实现,页面管线、编辑器预览、导入器三处
  共用:别名、锚点、语言镜像,解析不到时渲染死链标记而不是弄红构建。
- 🔐 **登录方式** —— 本地快速登录、Google OAuth、Google Workspace SAML SSO;
  HMAC cookie 或 JWT 会话(可跨子域 SSO);可选的文件式成员注册表与角色。
- 📤 **密码门控分享** —— 把单篇笔记连同全部资源快照成静态包,经一个
  一下午就能实现的小网关 API 对外发布。
- 🧾 **有底线的 Markdown 方言** —— GFM + CJK 友好的强调解析,一处定义、
  三处共用(页面渲染、保存校验、编辑器预览);外加构建期**内容守门**:
  凡「写的和渲染的不一致」的静默变形——配不上对的 `*` `_` `~~`、吃掉正文的
  MDX 表达式、单行 `$$x$$`、KaTeX 渲不出的公式等——一律构建失败,
  精确到 file:line:column 并画出插标。
- 🩺 **检查 CLI** —— `check-content.mjs`(用与生产完全一致的方言真编译每个
  源文件)与 `check-dist.mjs`(构建产物的死链、悬空锚点、语言段重复、
  `<a>` 嵌套、KaTeX 报错残留)。
- 🪶 **生产构建零残留** —— CMS 只在 dev 模式激活。`astro build` 的产物与
  从未装过本包的站点逐字节一致。

## 工作方式

```
读者   →  静态构建产物(astro build)——nginx、Pages、对象存储……
作者   →  同一个仓在编辑域名上跑 `WIKI=1 astro dev`
           └─ 保存 → git 提交(autocommit)→ 推送(autopush)→ CI 重建静态站
```

编辑器就是开着本集成的 Astro dev server:「改完即生效」的编辑面需要一个常驻的
编译器,dev server 恰好就是。鉴权、会话与角色让它可以安全地放在真实域名后面;
面向读者的站点永远不运行其中任何代码。现成的双服务部署骨架(静态读者站 +
编辑机)在姊妹仓的
[`deploy/`](https://github.com/ventusff/astro-inkstone/tree/main/deploy)。

## 快速开始

跑起示范站——一个接好编辑器的多笔记小站:

```bash
git clone https://github.com/ventusff/astro-inkbrush
cd astro-inkbrush && npm install
cd demo && npm install
npm run wiki        # WIKI=1 astro dev → 打开站点,登录(本地登录),开始编辑
npm run build       # 阅读模式——顺便验证零残留
```

## 接入你的站点

三处改动,全部由一个环境变量把关(以 git submodule 引入本仓,依赖声明用
pnpm `workspace:*` 或 npm `file:`——本包按设计不发 npm):

```ts
// astro.config.ts
import { inkbrush, rehypeWikiBlocks } from 'astro-inkbrush';
import { markdownProcessor } from 'astro-inkbrush/markdown';

const WIKI_MODE = Boolean(process.env.WIKI);

export default defineConfig({
  markdown: {
    processor: markdownProcessor({
      remarkPlugins: [/* 站点自己的 */],
      rehypePlugins: [/* 站点自己的 */, ...(WIKI_MODE ? [rehypeWikiBlocks] : [])],
    }),
  },
  integrations: [...(WIKI_MODE ? [inkbrush()] : [])],
});
```

```astro
<!-- 每个笔记页:告诉 CMS 这一页对应哪个笔记(路由完全归站点) -->
<meta name="inkbrush-note" content={noteId} />
```

```bash
cp <本包检出路径>/inkbrush.config.example.ts inkbrush.config.ts   # 可选,按机器配置
WIKI=1 astro dev
```

不写配置文件也能跑——默认只开本地登录,其余全关。登录方式、成员注册表、
收件箱、分享与全部配置项见[使用手册](docs/manual.zh-CN.md)。

## 三者分工

```
astro-inkbrush   笔——编辑:块级 CMS、修订史、评论、AI、收件箱、
                 Markdown 方言与内容守门
astro-inkstone   砚——观感:token、内容样式、组件、管线预设
                 (预设建立在本包方言之上)
你的站点         手——身份:布局、路由、内容、部署
```

Inkbrush 在 CMS 之外唯一多管的一件事是 **Markdown 方言**——编辑器接受的块
必须和页面渲染的一模一样,所以解析规则只在一处定义、处处共用。

## 许可

[MIT](LICENSE) © Jianfei Guo
