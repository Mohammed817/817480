// 4May live news server — Node.js 20+, no third-party dependencies
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const FEED_URL = 'https://www.4may.net/sec/RSS.aspx';
const ROOT = __dirname;
const CACHE_MS = 5 * 60 * 1000;
const MAX_NEWS = 6; // Show at most six latest unique article titles, matching the desired short ticker.
let cache = { items: [], fetchedAt: 0, error: null };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function clean(s) {
  return decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function safeUrl(raw) {
  try {
    const u = new URL(decodeEntities(raw), 'https://www.4may.net/');
    return /^https?:$/.test(u.protocol) && /(^|\.)4may\.net$/i.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
function isArticleUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Keep real article pages only. Ignore section/category pages such as /sec/10 and /tab1.
    return /^\/Mnews\/\d+\/?$/i.test(u.pathname);
  } catch { return false; }
}
function titleKey(title) {
  return clean(title).toLocaleLowerCase('ar')
    .replace(/[ـ\u064B-\u065F\u0670]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}
function uniqueArticles(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const result = [];
  for (const item of items) {
    const title = clean(item.title);
    const url = safeUrl(item.url);
    if (!title || !url || !isArticleUrl(url) || title.length < 12) continue;
    if (/^(اهم الاخبار|أهم الأخبار|صحيفة 4 مايو الالكترونية|شئون الانتقالي|شؤون الانتقالي|اخبار وتقارير|أخبار وتقارير|عرب وعالم|قسم الفيديو|فيديو|الرئيسية|اتصل بنا|هيئة التحرير|المزيد)$/i.test(title)) continue;
    const key = titleKey(title);
    if (!key || seenUrls.has(url) || seenTitles.has(key)) continue;
    seenUrls.add(url);
    seenTitles.add(key);
    result.push({ title, url });
    if (result.length >= MAX_NEWS) break;
  }
  return result;
}
function parseFeed(body) {
  const found = [];
  // Parse RSS/Atom article records first.
  const blocks = body.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks) {
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)
      || block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)
      || block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
    const title = clean(titleMatch && titleMatch[1]);
    const url = safeUrl(linkMatch && linkMatch[1]);
    if (title && url) found.push({ title, url });
  }
  // Some publisher endpoints return HTML instead of XML. In that case, collect only article URLs.
  if (!found.length) {
    const re = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(body))) {
      const url = safeUrl(match[3]);
      const title = clean(match[5]);
      if (url && title) found.push({ title, url });
    }
  }
  return uniqueArticles(found);
}
async function updateCache(force = false) {
  if (!force && cache.items.length && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(FEED_URL, {
      headers: {
        'user-agent': '4MayNewsMirror/1.1 (+server-side RSS reader)',
        'accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Publisher returned HTTP ' + response.status);
    const body = await response.text();
    const items = parseFeed(body);
    if (!items.length) throw new Error('No unique article links found in publisher feed');
    cache = { items, fetchedAt: Date.now(), error: null };
  } catch (error) {
    cache.error = error.message || 'Fetch failed';
    if (!cache.items.length) console.error('News refresh failed:', cache.error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return cache;
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, service: '4may-live-news' }));
  }
  if (url.pathname === '/api/news') {
    const data = await updateCache(url.searchParams.get('refresh') === '1');
    return send(res, data.items.length ? 200 : 502, JSON.stringify({
      source: FEED_URL,
      updatedAt: data.fetchedAt ? new Date(data.fetchedAt).toISOString() : null,
      count: data.items.length,
      items: data.items,
      error: data.items.length ? null : data.error
    }));
  }
  let file;
  try { file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
  catch { return send(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  const full = path.resolve(ROOT, file);
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, 'index.html')) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }
  fs.readFile(full, (error, data) => {
    if (error) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
});
server.listen(PORT, HOST, () => {
  console.log(`4May live news server listening on ${HOST}:${PORT}`);
  updateCache(true);
});
setInterval(() => updateCache(true), CACHE_MS).unref();
