#!/usr/bin/env node
/**
 * Prerender for Claude Design ("dc") pages: <x-dc> template + support.js runtime.
 *
 * Problem: the page text lives in an <x-dc> template with {{ }} placeholders that
 * React (support.js) renders in the browser, so crawlers without JS see raw
 * {{ bike.name }} etc.
 *
 * What this does (idempotent, re-run after every edit of the page):
 *   1. Takes index.html in either form: "source" (plain <x-dc> as exported from
 *      Claude Design) or already prerendered (it restores the source first).
 *   2. Renders it in headless Chrome at 1440px, scrolls through so reveal
 *      animations and counters reach their final state.
 *   3. Writes back:
 *        <head>  + static copies of the <helmet> tags (title, meta, JSON-LD, CSS)
 *        <body>  <div id="dc-prerender"> static rendered HTML </div>
 *                <template id="dc-tpl"> original <x-dc> template, byte for byte </template>
 *                <script> tiny shim </script>
 *   The shim runs while the page is parsing: it drops the static copy, puts a
 *   live <x-dc> back where it was and removes duplicate head tags, so support.js
 *   boots exactly as before. Humans with JS get the same React page; bots and
 *   no-JS clients get the static HTML.
 *
 * Usage:  node _tools/prerender.mjs            (all pages in PAGES)
 *         node _tools/prerender.mjs --restore  (write the plain source form back)
 * Env:    CHROME_PATH=/path/to/chrome  PLAYWRIGHT_CORE=/path/to/playwright-core
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html'];
// A fixed weekday so date-dependent copy (e.g. "осталось N мест на выходные")
// is baked in its neutral form. Humans still get the live, date-based text.
const FIXED_TIME = '2026-09-30T12:00:00+03:00'; // Wednesday
const VIEWPORT = { width: 1440, height: 900 };

const M = {
  headStart: '<!--dc-prerender:head-->', headEnd: '<!--/dc-prerender:head-->',
  bodyStart: '<!--dc-prerender:body-->', bodyEnd: '<!--/dc-prerender:body-->',
};

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    '/Users/macos/Desktop/Сайты/_tools/casegen/node_modules/playwright-core/index.mjs',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const spec = c.startsWith('/') ? pathToFileURL(fs.statSync(c).isDirectory() ? path.join(c, 'index.mjs') : c).href : c;
      const mod = await import(spec);
      return mod.chromium || mod.default.chromium;
    } catch { /* try next */ }
  }
  throw new Error('playwright-core not found: npm i -D playwright-core or set PLAYWRIGHT_CORE');
}

function chromePath() {
  const list = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  return list.find((p) => fs.existsSync(p)); // undefined → playwright's own chromium
}

/** Prerendered file → plain Claude Design source (byte-identical to the original). */
export function toSource(html) {
  let out = html;
  const hs = out.indexOf(M.headStart), he = out.indexOf(M.headEnd);
  if (hs !== -1 && he !== -1) out = out.slice(0, hs) + out.slice(he + M.headEnd.length);
  const bs = out.indexOf(M.bodyStart), be = out.indexOf(M.bodyEnd);
  if (bs !== -1 && be !== -1) {
    const block = out.slice(bs, be);
    const open = /<x-dc(?:\s[^>]*)?>/.exec(block);
    const close = block.lastIndexOf('</x-dc>');
    if (!open || close === -1) throw new Error('prerender block without <x-dc> template');
    out = out.slice(0, bs) + block.slice(open.index, close + '</x-dc>'.length) + out.slice(be + M.bodyEnd.length);
  }
  return out;
}

const SHIM = `(function(){var d=document,h=d.documentElement,t=d.getElementById('dc-tpl'),p=d.getElementById('dc-prerender'),x=d.createElement('x-dc');x.innerHTML=t.content.querySelector('x-dc').innerHTML;t.parentNode.insertBefore(x,p||t);if(p)p.remove();d.querySelectorAll('[data-dc-pr]').forEach(function(e){e.remove()});h.classList.remove('dc-js');if(!h.className)h.removeAttribute('class')})();`;

function serve(overrides) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4',
    '.woff2': 'font/woff2', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = p.replace(/^\/+/, '');
    if (overrides[rel] != null) { res.writeHead(200, { 'content-type': types['.html'] }); return res.end(overrides[rel]); }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** Renders the source page and returns { body, head } static HTML strings. */
async function render(browser, url, helmetHtml, headKeys) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.route(/mc\.yandex\.|yandex\.ru\/metrika|google-analytics|googletagmanager/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => { const r = document.getElementById('dc-root'); return r && r.innerText.trim().length > 200 && !/\{\{/.test(r.innerText); }, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  // Scroll through so IntersectionObserver reveals / counters reach their final state.
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.6);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    await new Promise((r) => setTimeout(r, 1800));
    scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
  if (errors.length) throw new Error('page errors while rendering: ' + errors.join('; '));

  const result = await page.evaluate(({ helmet, headKeys }) => {
    const root = document.getElementById('dc-root').cloneNode(true);
    // counters: always the final number
    root.querySelectorAll('[data-count-target]').forEach((n) => { n.textContent = n.getAttribute('data-count-target'); });
    // reveal-on-scroll (class based variant)
    root.querySelectorAll('[data-reveal]').forEach((n) => {
      // deterministic output: class attribute always last, whether or not the observer already fired
      n.classList.add('in'); const c = n.getAttribute('class'); n.removeAttribute('class'); n.setAttribute('class', c);
    });
    root.querySelectorAll('script').forEach((n) => n.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const a of [...el.attributes]) if (a.name.startsWith('data-dc-')) el.removeAttribute(a.name);
      const tag = el.tagName;
      // The static copy must not make the browser download anything extra
      // (the preload scanner sees it before the shim removes it).
      if (tag === 'IMG' || tag === 'IFRAME') el.setAttribute('loading', 'lazy');
      if (tag === 'VIDEO') { el.removeAttribute('autoplay'); el.setAttribute('preload', 'none'); }
      if (tag === 'INPUT' || tag === 'TEXTAREA') el.removeAttribute('autofocus');
    }
    // <helmet> → static head tags that are not already in <head>
    const tmp = document.createElement('div');
    tmp.innerHTML = helmet;
    const headOut = [];
    for (const el of tmp.children) {
      const tag = el.tagName;
      const keep = tag === 'STYLE' || (tag === 'LINK' && /stylesheet|preconnect/i.test(el.rel));
      if (tag === 'TITLE') { if (headKeys.includes('title')) continue; }
      else if (tag === 'META') {
        const k = el.getAttribute('name') ? `meta[name="${el.getAttribute('name')}"]` : el.getAttribute('property') ? `meta[property="${el.getAttribute('property')}"]` : null;
        if (!k) continue;
        if (headKeys.includes(k)) continue;
      } else if (tag === 'LINK') {
        const k = `link[rel="${el.getAttribute('rel')}"][href="${el.getAttribute('href')}"]`;
        if (headKeys.includes(k)) continue;
      } else if (tag === 'SCRIPT') { if (!/ld\+json/i.test(el.type)) continue; }
      else if (tag !== 'STYLE') continue;
      if (!keep) el.setAttribute('data-dc-pr', '');
      headOut.push(el.outerHTML);
    }
    return { body: root.innerHTML, head: headOut.join('\n'), text: document.getElementById('dc-root').innerText };
  }, { helmet: helmetHtml, headKeys });
  await ctx.close();
  return result;
}

/** Keys of tags already present in the static <head> of the source file. */
function staticHeadKeys(src) {
  const head = src.slice(0, src.search(/<\/head>/i));
  const keys = [];
  if (/<title[\s>]/i.test(head)) keys.push('title');
  for (const m of head.matchAll(/<meta\s[^>]*?(name|property)="([^"]+)"/gi)) keys.push(`meta[${m[1].toLowerCase()}="${m[2]}"]`);
  for (const m of head.matchAll(/<link\s[^>]*>/gi)) {
    const rel = /rel="([^"]+)"/i.exec(m[0]); const href = /href="([^"]+)"/i.exec(m[0]);
    if (rel && href) keys.push(`link[rel="${rel[1]}"][href="${href[1]}"]`);
  }
  return keys;
}

function build(src, r) {
  const open = /<x-dc(?:\s[^>]*)?>/.exec(src);
  const close = src.lastIndexOf('</x-dc>');
  if (!open || close === -1) throw new Error('no <x-dc> template in page');
  const tpl = src.slice(open.index, close + '</x-dc>'.length);
  if (/<\/template>/i.test(tpl.replace(/<template[\s\S]*?<\/template>/gi, ''))) throw new Error('unbalanced </template> in template');
  for (const bad of ['<!--dc-prerender', '<!--/dc-prerender']) if (r.body.includes(bad)) throw new Error('marker inside render');
  if (/<x-dc[\s>]|<\/x-dc>/i.test(r.body + r.head)) throw new Error('rendered HTML contains x-dc tag');

  const head = `${M.headStart}
<script data-dc-pr>document.documentElement.classList.add('dc-js')</script>
<style data-dc-pr>html.dc-js #dc-prerender{display:none!important}</style>
${r.head}
${M.headEnd}`;
  const body = `${M.bodyStart}<div id="dc-prerender">${r.body}</div>
<template id="dc-tpl">${tpl}</template>
<script>${SHIM}</script>${M.bodyEnd}`;
  let out = src.slice(0, open.index) + body + src.slice(close + '</x-dc>'.length);
  const hi = out.search(/<\/head>/i);
  out = out.slice(0, hi) + head + out.slice(hi);
  return out;
}

async function main() {
  const restore = process.argv.includes('--restore');
  const pages = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const list = pages.length ? pages : PAGES;
  const sources = Object.fromEntries(list.map((p) => [p, toSource(fs.readFileSync(path.join(ROOT, p), 'utf8'))]));
  if (restore) { for (const p of list) fs.writeFileSync(path.join(ROOT, p), sources[p]); console.log('restored source form:', list.join(', ')); return; }

  const chromium = await loadPlaywright();
  const server = await serve(sources);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    for (const p of list) {
      const src = sources[p];
      const helmet = (/<helmet>([\s\S]*?)<\/helmet>/i.exec(src) || [, ''])[1];
      const url = base + (p === 'index.html' ? '' : p);
      const r = await render(browser, url, helmet, staticHeadKeys(src));
      if (/\{\{/.test(r.body)) throw new Error(`${p}: unresolved {{ }} in rendered HTML`);
      const out = build(src, r);
      if (toSource(out) !== src) throw new Error(`${p}: round-trip check failed`);
      fs.writeFileSync(path.join(ROOT, p), out);
      console.log(`${p}: prerendered ${Math.round(r.body.length / 1024)} KB of static HTML, ${r.text.length} chars of text`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
