// 4May live news server — Node.js 20+, no third-party dependencies
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const FEED_URL = 'https://www.4may.net/news/RSS.aspx';
const ROOT = __dirname;
const CACHE_MS = 10 * 60 * 1000;
let cache = { items: [], fetchedAt: 0, error: null };
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function clean(s) { return decodeEntities(String(s||'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
function safeUrl(raw) {
  try { const u = new URL(decodeEntities(raw), 'https://www.4may.net/'); return /^https?:$/.test(u.protocol) && /(^|\.)4may\.net$/i.test(u.hostname) ? u.href : null; } catch { return null; }
}
function parseFeed(body) {
  const items = [];
  // Standard RSS/Atom XML first
  const blocks = body.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const b of blocks) {
    const tm = b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const lm = b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i) || b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const title = clean(tm && tm[1]); const url = safeUrl(lm && lm[1]);
    if (title && url) items.push({title,url});
  }
  if (items.length) return unique(items).slice(0,30);
  // The publisher's RSS.aspx endpoint may return a rendered HTML page; extract story links.
  const re = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(body))) {
    const url = safeUrl(m[3]); const title = clean(m[5]);
    if (url && title && title.length > 12 && !/^(الرئيسية|اتصل بنا|هيئة التحرير|المزيد|اخبار وتقارير|عرب وعالم|مجتمع|قيديو|فيديو)$/i.test(title)) items.push({title,url});
  }
  return unique(items).slice(0,30);
}
function unique(items) { const seen = new Set(); return items.filter(x => { const k=x.url; if(seen.has(k)) return false; seen.add(k); return true; }); }
async function updateCache(force=false) {
  if (!force && cache.items.length && Date.now()-cache.fetchedAt < CACHE_MS) return cache;
  try {
    const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), 15000);
    const res = await fetch(FEED_URL, { headers: {'user-agent':'4MayNewsMirror/1.0 (+server-side RSS reader)','accept':'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8'}, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('Publisher returned HTTP '+res.status);
    const body = await res.text(); const items = parseFeed(body);
    if (!items.length) throw new Error('No article links found in publisher feed');
    cache = {items, fetchedAt:Date.now(), error:null};
  } catch (e) { cache.error = e.message || 'Fetch failed'; if (!cache.items.length) console.error('News refresh failed:', cache.error); }
  return cache;
}
function send(res,status,body,type='application/json; charset=utf-8') { res.writeHead(status, {'content-type':type,'cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff'}); res.end(body); }
const server = http.createServer(async (req,res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/health') return send(res,200,JSON.stringify({ok:true,service:'4may-live-news'}));
  if (u.pathname === '/api/news') {
    const data = await updateCache(u.searchParams.get('refresh') === '1');
    return send(res, data.items.length ? 200 : 502, JSON.stringify({source:FEED_URL,updatedAt:data.fetchedAt ? new Date(data.fetchedAt).toISOString() : null,items:data.items,error:data.items.length ? null : data.error}));
  }
  let file = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const full = path.resolve(ROOT, file);
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT,'index.html')) return send(res,403,'Forbidden','text/plain; charset=utf-8');
  fs.readFile(full,(err,data)=>{
    if(err) return send(res,404,'Not found','text/plain; charset=utf-8');
    const ext=path.extname(full); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon'};
    res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-cache':'public, max-age=3600','x-content-type-options':'nosniff'}); res.end(data);
  });
});
server.listen(PORT,HOST,()=>{console.log(`4May live news server listening on ${HOST}:${PORT}`); updateCache(true);});
setInterval(()=>updateCache(true),CACHE_MS).unref();
