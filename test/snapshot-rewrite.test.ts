/**
 * Unit tests for the share-snapshot URL re-basing.
 *
 * The snapshot moves `index.html` to the share root while assets keep the
 * site's directory layout, so every reference has to be re-expressed relative
 * to that root. Root-relative refs were always handled; page-relative ones —
 * what co-located note attachments use — were not, and every attachment 404'd
 * under `/s/<id>/`. These tests pin both, plus the values that must be left
 * strictly alone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executableMarkup, rewriteCssFile, rewriteHtml, rewriteRef } from '../src/wiki/server/snapshot.ts';

/** where a reader actually loads the page from */
const SHARE_BASE = 'https://gw.example.com/s/C4tigg1Dbp/';

const PAGE = 'docs/en/sample-note';

test('page-relative refs re-base onto the page directory', () => {
  assert.equal(rewriteRef('fig.jpg', PAGE), './docs/en/sample-note/fig.jpg');
  assert.equal(rewriteRef('./fig.jpg', PAGE), './docs/en/sample-note/fig.jpg');
  assert.equal(rewriteRef('sub/fig.jpg', PAGE), './docs/en/sample-note/sub/fig.jpg');
  assert.equal(rewriteRef('../sibling/a.png', PAGE), './docs/en/sibling/a.png');
});

test('root-relative refs lose the leading slash only', () => {
  assert.equal(rewriteRef('/_astro/app.css', PAGE), './_astro/app.css');
  assert.equal(rewriteRef('/docs/en/sample-note/fig.jpg', PAGE), './docs/en/sample-note/fig.jpg');
  assert.equal(rewriteRef('/favicon.svg', ''), './favicon.svg');
});

test('a root-level page re-bases page-relative refs onto the root', () => {
  assert.equal(rewriteRef('fig.jpg', ''), './fig.jpg');
  assert.equal(rewriteRef('./a/b.png', ''), './a/b.png');
});

test('absolute, protocol-relative, fragment-only and data refs are untouched', () => {
  for (const ref of [
    'https://example.com/a.png',
    'http://example.com/a.png',
    '//cdn.example.com/a.png',
    'data:image/svg+xml;base64,AAAA',
    'mailto:hi@example.com',
    '#section',
    '?query=1',
    '',
  ]) {
    assert.equal(rewriteRef(ref, PAGE), ref, `must not touch ${JSON.stringify(ref)}`);
  }
});

test('fragment and query survive re-basing', () => {
  assert.equal(rewriteRef('fig.svg#icon', PAGE), './docs/en/sample-note/fig.svg#icon');
  assert.equal(rewriteRef('data.json?v=2', PAGE), './docs/en/sample-note/data.json?v=2');
  assert.equal(rewriteRef('/_astro/a.css?v=2#x', PAGE), './_astro/a.css?v=2#x');
});

test('a link to the page itself lands on the share root', () => {
  assert.equal(rewriteRef('/docs/en/sample-note/', PAGE), './');
  assert.equal(rewriteRef('/docs/en/sample-note/index.html', PAGE), './');
  assert.equal(rewriteRef('./', PAGE), './');
  assert.equal(rewriteRef('/docs/en/sample-note/#part-2', PAGE), './#part-2');
  assert.equal(rewriteRef('/', ''), './');
});

test('the site root is not mistaken for the page when the page is nested', () => {
  assert.equal(rewriteRef('/', PAGE), './');
  assert.equal(rewriteRef('/docs/', PAGE), './docs/');
});

test('a trailing slash (directory route) is preserved', () => {
  assert.equal(rewriteRef('../other-note/', PAGE), './docs/en/other-note/');
  assert.equal(rewriteRef('/docs/', PAGE), './docs/');
});


/* ---------------- whole-document behaviour ---------------- */

test('document rewrite covers attributes, srcset and inline style', () => {
  const html = [
    '<html><head><link rel="stylesheet" href="/_astro/app.css">',
    '<style>.a{background:url(bg.png)}.b{background:url("/_astro/x.png")}</style></head>',
    '<body><img src="fig.jpg" alt="a">',
    '<img data-src="not-a-url.jpg" src="./sub/fig2.jpg">',
    '<img srcset="small.jpg 1x, /_astro/large.jpg 2x">',
    "<a href='rel/page/'>rel dir</a>",
    '<a href="https://example.com/x">ext</a><a href="#anchor">frag</a>',
    '</body></html>',
  ].join('');
  const out = rewriteHtml(html, PAGE);

  assert.match(out, /href="\.\/_astro\/app\.css"/);
  assert.match(out, /src="\.\/docs\/en\/sample-note\/fig\.jpg"/);
  assert.match(out, /src="\.\/docs\/en\/sample-note\/sub\/fig2\.jpg"/);
  assert.match(out, /srcset="\.\/docs\/en\/sample-note\/small\.jpg 1x, \.\/_astro\/large\.jpg 2x"/);
  assert.match(out, /url\(\.\/docs\/en\/sample-note\/bg\.png\)/);
  assert.match(out, /url\("\.\/_astro\/x\.png"\)/);
  assert.match(out, /href='\.\/docs\/en\/sample-note\/rel\/page\/'/);
  // left strictly alone
  assert.match(out, /data-src="not-a-url\.jpg"/);
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  assert.match(out, /href="#anchor"/);
  // injected hardening
  assert.match(out, /name="robots" content="noindex,nofollow"/);
  assert.match(out, /vite:preloadError/);
});

test('single-quoted attributes keep their quote style', () => {
  assert.match(rewriteHtml("<img src='fig.jpg'>", PAGE), /src='\.\/docs\/en\/sample-note\/fig\.jpg'/);
});


/* ---------------- copied stylesheets ---------------- */

test('root-relative refs inside a copied stylesheet become file-relative', () => {
  const css = '@font-face{src:url(/_astro/KaTeX.woff2) format("woff2")}.a{background:url("/img/bg.png")}';
  const out = rewriteCssFile(css, '_astro');
  assert.match(out, /url\(\.\/KaTeX\.woff2\)/);
  assert.match(out, /url\("\.\.\/img\/bg\.png"\)/);
});

test('relative refs inside a stylesheet are left alone (the file keeps its place)', () => {
  const css = '.a{background:url(./local.png)}.b{background:url(sub/x.png)}.c{background:url(../up.png)}';
  assert.equal(rewriteCssFile(css, '_astro'), css);
});

test('stylesheet refs keep fragment/query, and remote refs are untouched', () => {
  assert.match(rewriteCssFile('.a{background:url(/_astro/s.svg#icon)}', '_astro'), /url\(\.\/s\.svg#icon\)/);
  assert.match(rewriteCssFile('.a{background:url(/_astro/f.woff2?v=2)}', '_astro'), /url\(\.\/f\.woff2\?v=2\)/);
  const remote = '.a{background:url(https://cdn.example.com/x.png)}.b{background:url(//cdn/y.png)}';
  assert.equal(rewriteCssFile(remote, '_astro'), remote);
});

test('@import is re-based the same way', () => {
  assert.match(rewriteCssFile('@import "/_astro/base.css";', '_astro'), /@import "\.\/base\.css";/);
});

test('a url() written inside a CSS string is display text, not a reference', () => {
  const css = '.x::before{content:"url(/docs/help)"}.y::after{content:\'url(/a.png)\'}';
  assert.equal(rewriteCssFile(css, '_astro'), css);
});

test('a url() inside a CSS comment is left alone', () => {
  const css = '/* background:url(/img/old.png) */.a{background:url(/img/new.png)}';
  const out = rewriteCssFile(css, '_astro');
  assert.match(out, /\/\* background:url\(\/img\/old\.png\) \*\//);
  assert.match(out, /background:url\(\.\.\/img\/new\.png\)/);
});

test('an escaped quote inside a string does not end it', () => {
  const css = '.a{content:"he said \\"url(/x.png)\\""}.b{background:url(/img/y.png)}';
  const out = rewriteCssFile(css, '_astro');
  assert.match(out, /content:"he said \\"url\(\/x\.png\)\\""/);
  assert.match(out, /background:url\(\.\.\/img\/y\.png\)/);
});

test('url() whitespace, case and adjacency are preserved', () => {
  assert.match(rewriteCssFile('.a{background:URL( /img/x.png )}', ''), /URL\( \.\/img\/x\.png \)/);
  assert.match(rewriteCssFile('.a{background:url(/img/x.png)no-repeat}', ''), /url\(\.\/img\/x\.png\)no-repeat/);
  assert.equal(rewriteCssFile('.a{background:url()}', ''), '.a{background:url()}');
});

test('an identifier merely ending in url is not a url() token', () => {
  const css = '.a{--myurl(x):1;background:blurl(/img/x.png)}';
  assert.equal(rewriteCssFile(css, '_astro'), css);
});

test('an unterminated url() or comment leaves the bytes untouched', () => {
  for (const css of ['.a{background:url(/img/x.png', '/* url(/img/x.png)', '.a{content:"url(/x)']) {
    assert.equal(rewriteCssFile(css, '_astro'), css, css);
  }
});

test('@import is re-based in both spellings, and only as the import target', () => {
  assert.match(rewriteCssFile('@import url("/_astro/a.css") screen;', '_astro'), /@import url\("\.\/a\.css"\) screen;/);
  assert.match(rewriteCssFile("@import '/_astro/b.css';", '_astro'), /@import '\.\/b\.css';/);
  // a string that merely follows an @import rule is not itself a target
  const after = '@import "/_astro/c.css";.a{content:"/_astro/d.css"}';
  const out = rewriteCssFile(after, '_astro');
  assert.match(out, /@import "\.\/c\.css";/);
  assert.match(out, /content:"\/_astro\/d\.css"/);
});

test('CSS escapes are decoded before re-basing, not passed through', () => {
  // `\/` and `\2f ` both mean `/` — a ref that stays encoded never gets re-based
  assert.match(rewriteCssFile('.a{background:url(\\/img/a.png)}', '_astro'), /url\("\.\.\/img\/a\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url(\\2f img/b.png)}', '_astro'), /url\("\.\.\/img\/b\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url("\\2f img\\2f c.png")}', ''), /url\("\.\/img\/c\.png"\)/);
  assert.match(rewriteCssFile('@import "\\2f _astro\\2f d.css";', '_astro'), /@import "\.\/d\.css";/);
});

test('an escaped space or paren in a filename survives the round trip', () => {
  assert.match(rewriteCssFile('.a{background:url(/img/a\\ b.png)}', '_astro'), /url\("\.\.\/img\/a b\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url(/img/c\\)d.png)}', '_astro'), /url\("\.\.\/img\/c\)d\.png"\)/);
});

test('CSS escape decoding follows the syntax spec', () => {
  // a lone surrogate, U+0000 and an out-of-range code point all become U+FFFD
  assert.match(rewriteCssFile('.a{background:url(/img/\\D800.png)}', ''), /url\("\.\/img\/�\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url(/img/\\0.png)}', ''), /url\("\.\/img\/�\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url(/img/\\110000.png)}', ''), /url\("\.\/img\/�\.png"\)/);
  // CR, FF and CRLF after a backslash are line continuations, not characters
  for (const nl of ['\r', '\f', '\r\n', '\n']) {
    assert.match(rewriteCssFile(`.a{background:url("/img/a\\${nl}b.png")}`, ''), /url\("\.\/img\/ab\.png"\)/, JSON.stringify(nl));
  }
  // a hex escape swallows exactly one following whitespace, CRLF counting as one
  assert.match(rewriteCssFile('.a{background:url("/img/\\41\r\nb.png")}', ''), /url\("\.\/img\/Ab\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url("/img/\\41 b.png")}', ''), /url\("\.\/img\/Ab\.png"\)/);
  assert.match(rewriteCssFile('.a{background:url("/img/\\41  b.png")}', ''), /url\("\.\/img\/A b\.png"\)/);
});

test('an escaped trailing space belongs to the filename, not to the syntax', () => {
  const out = rewriteCssFile('.a{background:url(/img/a\\ )}', '_astro');
  assert.match(out, /url\("\.\.\/img\/a "\)/);
  // and unescaped trailing whitespace is still syntax
  assert.match(rewriteCssFile('.a{background:url(/img/b.png  )}', '_astro'), /url\("?\.\.\/img\/b\.png"?  \)/);
});

test('a decoded control character is re-escaped when written back', () => {
  // `\D ` is a carriage return — the space terminates the hex digits, so the
  // following `b` stays a letter instead of extending the code point
  const out = rewriteCssFile('.a{background:url("/img/a\\D b.png")}', '');
  assert.equal(out.includes('\r'), false);
  assert.match(out, /url\("\.\/img\/a\\d b\.png"\)/);
  // greedy hex is correct CSS: `\Db` really is U+00DB
  assert.match(rewriteCssFile('.a{background:url("/img/a\\Db.png")}', ''), /url\("\.\/img\/aÛ\.png"\)/);
});

test('a quoted url() keeps a ) inside the filename intact', () => {
  assert.match(rewriteCssFile('.a{background:url("/img/a)b.png")}', '_astro'), /url\("\.\.\/img\/a\)b\.png"\)/);
  assert.match(rewriteCssFile(".a{background:url('/img/c)d.png')}", ''), /url\('\.\/img\/c\)d\.png'\)/);
});

test('a stylesheet at the snapshot root re-bases onto the root', () => {
  assert.match(rewriteCssFile('.a{background:url(/img/bg.png)}', ''), /url\(\.\/img\/bg\.png\)/);
});

/* ---------------- what must NOT be touched ---------------- */

test('an HTML sample inside a code block is content, not a reference', () => {
  // fenced samples reach the output as literal text — quotes and all
  const html = '<pre><code>&lt;img src="fig.jpg"&gt;</code></pre>';
  assert.equal(rewriteHtml(html, PAGE).includes('src="fig.jpg"'), true);
});

test('strings inside inline scripts are left alone', () => {
  const html = '<script>const demo = \'<img src="fig.jpg">\';</script>';
  const out = rewriteHtml(html, PAGE);
  assert.match(out, /src="fig\.jpg"/);
  assert.equal(out.includes('./docs/en/sample-note/fig.jpg'), false);
});

test('inline scripts still get their /_astro/ refs re-based', () => {
  const out = rewriteHtml('<script>const c = "/_astro/chunk.js";</script>', PAGE);
  assert.match(out, /"\.\/_astro\/chunk\.js"/);
});

test('HTML comments are copied verbatim', () => {
  const html = '<!-- example: <a href="guide.html"> --><a href="guide.html">x</a>';
  const out = rewriteHtml(html, PAGE);
  assert.match(out, /<!-- example: <a href="guide\.html"> -->/);
  assert.match(out, /<a href="\.\/docs\/en\/sample-note\/guide\.html">/);
});

test('an attribute value containing > does not break tag scanning', () => {
  const out = rewriteHtml('<div data-x="a > b"><img src="fig.jpg"></div>', PAGE);
  assert.match(out, /data-x="a > b"/);
  assert.match(out, /src="\.\/docs\/en\/sample-note\/fig\.jpg"/);
});

/* ---------------- srcset grammar ---------------- */

test('srcset keeps data URLs whole (commas inside a URL are not separators)', () => {
  const out = rewriteHtml('<img srcset="data:image/svg+xml,%3Csvg%3E 1x, fig.jpg 2x">', PAGE);
  assert.match(out, /data:image\/svg\+xml,%3Csvg%3E 1x/);
  assert.match(out, /\.\/docs\/en\/sample-note\/fig\.jpg 2x/);
});

test('srcset handles commas in query strings and missing descriptors', () => {
  const out = rewriteHtml('<img srcset="a.jpg?crop=1,2,3 2x, b.jpg">', PAGE);
  assert.match(out, /\.\/docs\/en\/sample-note\/a\.jpg\?crop=1,2,3 2x/);
  assert.match(out, /\.\/docs\/en\/sample-note\/b\.jpg/);
});

test('imagesrcset is re-based like srcset', () => {
  const out = rewriteHtml('<link rel="preload" imagesrcset="hero.jpg 1x">', PAGE);
  assert.match(out, /imagesrcset="\.\/docs\/en\/sample-note\/hero\.jpg 1x"/);
});

/* ---------------- other reference carriers ---------------- */

test('style attributes carry url() refs too', () => {
  const out = rewriteHtml('<div style="background:url(fig.jpg)"></div>', PAGE);
  assert.match(out, /style="background:url\(\.\/docs\/en\/sample-note\/fig\.jpg\)"/);
});

test('unquoted attribute values are re-based and re-quoted when needed', () => {
  const out = rewriteHtml('<img src=fig.jpg>', PAGE);
  assert.match(out, /src=\.\/docs\/en\/sample-note\/fig\.jpg>/);
});

test('form action and the rarer URL attributes are re-based', () => {
  assert.match(rewriteHtml('<form action="submit"></form>', PAGE), /action="\.\/docs\/en\/sample-note\/submit"/);
  assert.match(rewriteHtml('<blockquote cite="source.html">', PAGE), /cite="\.\/docs\/en\/sample-note\/source\.html"/);
  assert.match(rewriteHtml('<html manifest="/app.manifest">', PAGE), /manifest="\.\/app\.manifest"/);
});

test('xlink:href inside SVG is re-based', () => {
  const out = rewriteHtml('<svg><use xlink:href="icons.svg#x"/></svg>', PAGE);
  assert.match(out, /xlink:href="\.\/docs\/en\/sample-note\/icons\.svg#x"/);
});

/* ---------------- escaping the share scope ---------------- */

test('a ../ chain past the site root is clamped, never returned as an escape', () => {
  assert.equal(rewriteRef('../../../../etc/passwd', PAGE), './etc/passwd');
  assert.equal(rewriteRef('../../../../../admin', 'a/b'), './admin');
  for (const escaped of [rewriteRef('../x.png', ''), rewriteRef('../../y', 'a')]) {
    assert.equal(escaped.startsWith('./'), true, `${escaped} must stay inside the share`);
  }
});

test('encoded dot segments and backslashes cannot climb out either', () => {
  // a browser normalizes %2e as a dot segment and \ as a separator, so a ref
  // that looks inert as text can still resolve above the share root
  assert.equal(rewriteRef('/%2e%2e/%2e%2e/admin', PAGE), './admin');
  assert.equal(rewriteRef('%2E%2E/%2E%2E/%2E%2E/secret', 'a/b'), './secret');
  assert.equal(rewriteRef('..\\..\\..\\admin', PAGE), './admin');
  assert.equal(rewriteRef('/..\\admin', PAGE), './admin');
});

test('every rewritten ref resolves inside /s/<id>/ by browser rules', () => {
  const hostile = [
    '../../../../etc/passwd',
    '/%2e%2e/%2e%2e/admin',
    '%2e%2e%2f%2e%2e%2fadmin',
    '..\\..\\admin',
    '/../admin',
    './../../x',
    'a/../../../../b',
  ];
  for (const dir of [PAGE, 'a/b', '']) {
    for (const ref of hostile) {
      const resolved = new URL(rewriteRef(ref, dir), SHARE_BASE).pathname;
      assert.equal(
        resolved.startsWith('/s/C4tigg1Dbp/'),
        true,
        `${ref} (page ${dir || '<root>'}) escaped to ${resolved}`,
      );
    }
  }
});

test('stylesheet refs cannot climb above the snapshot root', () => {
  for (const [css, cssDir] of [
    ['.a{background:url(/../admin)}', '_astro'],
    ['.a{background:url(/%2e%2e/%2e%2e/admin)}', '_astro'],
    ['.a{background:url(/../../x.png)}', ''],
  ] as const) {
    const ref = /url\(([^)]*)\)/.exec(rewriteCssFile(css, cssDir))?.[1] ?? '';
    const cssUrl = new URL(cssDir ? `${cssDir}/s.css` : 's.css', SHARE_BASE);
    assert.equal(
      new URL(ref, cssUrl).pathname.startsWith('/s/C4tigg1Dbp/'),
      true,
      `${css} from ${cssDir || '<root>'} escaped via ${ref}`,
    );
  }
});

test('non-ASCII and spaced filenames keep their literal characters', () => {
  // the gateway maps request paths to files literally; percent-encoding here
  // would turn a working attachment into a 404
  assert.equal(rewriteRef('图 一.jpg', PAGE), './docs/en/sample-note/图 一.jpg');
});

test('robots meta is not injected twice regardless of quoting', () => {
  for (const head of [
    '<head><meta name=robots content=\'noindex\'></head>',
    '<head><meta name="robots" content="noindex"></head>',
  ]) {
    assert.equal(rewriteHtml(head, PAGE).match(/name=["']?robots["'\s>]/gi)?.length, 1, head);
  }
  // a different meta whose value merely starts with "robots" is not a match
  assert.match(rewriteHtml('<head><meta name="robotstxt" content="x"></head>', PAGE), /name="robots" content="noindex,nofollow"/);
});

test('a stylesheet dense with url() tokens stays linear too', () => {
  const css = '.c{background:url(/img/a.png)}'.repeat(60_000);
  const started = process.hrtime.bigint();
  const out = rewriteCssFile(css, '_astro');
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(out.includes('url(../img/a.png)'), true);
  assert.ok(seconds < 20, `${seconds.toFixed(1)}s for 60k url() tokens — the scan is copying the tail`);
});

test('a document far larger than any note finishes in one pass', () => {
  // Measured separately, cost per element holds flat from 2k to 128k elements,
  // so the walk is linear. A wall-clock ratio would only measure the noise of a
  // shared machine, hence a single loose ceiling: it catches a quadratic
  // regression (which would take minutes here) and nothing else.
  const html = `<div>${'<p><img src="fig.jpg"><style data-x=">">'.repeat(30_000)}</div>`;
  const started = process.hrtime.bigint();
  const out = rewriteHtml(html, PAGE);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(out.includes('./docs/en/sample-note/fig.jpg'), true);
  assert.ok(seconds < 20, `${seconds.toFixed(1)}s for a 30k-element document — the walk is not linear`);
});

test('malformed markup does not lose content or hang', () => {
  for (const html of [
    '<img src="fig.jpg',            // unterminated tag
    '<img src="fig.jpg alt=x>',     // unterminated quote
    '<script>var a = "</scr" + "ipt>";</script><img src="fig.jpg">',
    '<style>.a{background:url(bg.png)',
    '<div <img src="fig.jpg">',
  ]) {
    const out = rewriteHtml(html, PAGE);
    assert.ok(out.length > 0, html);
    assert.equal(out.includes('\u0000'), false, html);
  }
});


/* ---------------- the CMS-leak check ---------------- */

test('a note that documents an endpoint is not mistaken for a CMS leak', () => {
  // this exact page could not be shared at all: the hygiene check matched the
  // endpoint printed in its SAML settings table
  const html = '<body><table><tr><td>ACS URL</td><td><code>https://hub.example.com/api/wiki/auth/saml/callback</code></td></tr></table></body>';
  assert.equal(executableMarkup(html).includes('/api/wiki'), false);
});

test('an actual CMS leak is still caught, in a tag or in a script', () => {
  for (const html of [
    '<script src="/api/wiki/client.js"></script>',
    '<script>fetch("/api/wiki/blocks")</script>',
    '<script type="module" src="/@vite/client"></script>',
    '<astro-dev-toolbar></astro-dev-toolbar>',
  ]) {
    const markup = executableMarkup(html);
    assert.equal(
      ['/api/wiki', '@vite/client', 'astro-dev-toolbar'].some((m) => markup.includes(m)),
      true,
      html,
    );
  }
});

test('the leak check ignores prose and comments but keeps every tag', () => {
  const html = '<!-- /api/wiki in a comment --><p>text about /api/wiki</p><img src="fig.jpg">';
  const markup = executableMarkup(html);
  assert.equal(markup.includes('/api/wiki'), false);
  assert.match(markup, /<img src="fig\.jpg">/);
});
