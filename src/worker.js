import { PepperState } from './state.js';

export { PepperState };

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
});

function json(data, env, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...CORS(env),
      ...(init.headers || {})
    }
  });
}

async function getJson(env, path) {
  const res = await fetch(env.VIDUKI_API_BASE + path, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/137 Safari/537.36',
      Origin: env.VIDUKI_ORIGIN,
      Referer: `${env.VIDUKI_ORIGIN}/`,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`upstream ${path} non-JSON (${res.status})`); }
  if (!res.ok) throw new Error(`upstream ${path} failed (${res.status})`);
  return data;
}

function sourcePath({ type, tmdb_id, season, episode, server }) {
  const id  = encodeURIComponent(String(tmdb_id));
  const srv = encodeURIComponent(String(server));
  if (type === 'tv') {
    return `/main/tv/${id}/${encodeURIComponent(String(season))}/${encodeURIComponent(String(episode))}?srv=${srv}`;
  }
  return `/main/movie/${id}?srv=${srv}`;
}

function findUrl(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) return value.url;
  for (const child of Object.values(value)) {
    const found = findUrl(child);
    if (found) return found;
  }
  return null;
}

async function getServers(env) {
  const data = await getJson(env, '/main/servers');
  return Array.isArray(data) ? data : (Array.isArray(data?.servers) ? data.servers : data?.data || []);
}

function getState(env) {
  const id = env.PEPPER_STATE.idFromName('global');
  return env.PEPPER_STATE.get(id);
}

async function resolvePath(env, path) {
  const stub = getState(env);
  const res = await stub.fetch('https://do/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'resolve failed');
  return data.data;
}

async function resolveAll(env, input) {
  const servers = await getServers(env);
  const results = [];
  for (let i = 0; i < servers.length; i += 3) {
    const batch = servers.slice(i, i + 3);
    const rows = await Promise.all(batch.map(async (server) => {
      const name = typeof server === 'string' ? server : server.name;
      try {
        const data = await resolvePath(env, sourcePath({ ...input, server: name }));
        return { server: name, ok: true, stream_url: findUrl(data), data };
      } catch (error) {
        return { server: name, ok: false, error: error.message };
      }
    }));
    results.push(...rows);
  }
  return {
    servers,
    results,
    success_count: results.filter(x => x.ok && x.stream_url).length
  };
}

const PAGE = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>فاحص مصادر التشغيل</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#141b31;--line:#2a3559;--text:#edf2ff;--muted:#9ca8c7;--accent:#7c9cff;--ok:#50d890;--bad:#ff7185}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#1b2850 0,#0b1020 45%);color:var(--text);font:16px system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:34px 18px}h1{margin:0 0 8px;font-size:30px}p{color:var(--muted)}.panel{background:rgba(20,27,49,.88);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:0 18px 60px #0004}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:flex;flex-direction:column;gap:7px}label{color:var(--muted);font-size:14px}input,select,button{border:1px solid var(--line);border-radius:10px;background:#0c1327;color:var(--text);padding:12px;font:inherit}button{background:var(--accent);border:0;color:#081027;font-weight:700;cursor:pointer;margin-top:16px}button:disabled{opacity:.5;cursor:wait}.stats{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 11px;color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:right;border-bottom:1px solid var(--line);padding:12px 8px;vertical-align:top}th{color:var(--muted);font-weight:500}.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:#a9bcff;word-break:break-all}.small{font-size:13px;color:var(--muted)}@media(max-width:700px){.grid{grid-template-columns:1fr}h1{font-size:24px}main{padding:20px 12px}}</style></head><body><main><div class="panel"><h1>فاحص مصادر التشغيل</h1><p>أدخل TMDB ID لفحص جميع السيرفرات التي يرجعها الموقع. الروابط مؤقتة وموقعة.</p><form id="form"><div class="grid"><div class="field"><label>النوع</label><select id="type"><option value="movie">فيلم</option><option value="tv">مسلسل</option></select></div><div class="field"><label>TMDB ID</label><input id="id" required inputmode="numeric" placeholder="مثال: 533535"></div><div class="field tv"><label>الموسم</label><input id="season" type="number" min="1" value="1"></div><div class="field tv"><label>الحلقة</label><input id="episode" type="number" min="1" value="1"></div></div><button id="submit">فحص كل السيرفرات</button></form><div id="status" class="small"></div><div id="stats" class="stats"></div><div id="out"></div></div></main><script>
const $=id=>document.getElementById(id),type=$('type');function toggle(){document.querySelectorAll('.tv').forEach(x=>x.style.display=type.value==='tv'?'flex':'none')}type.onchange=toggle;toggle();$('form').onsubmit=async e=>{e.preventDefault();const btn=$('submit');btn.disabled=true;$('status').textContent='جارِ طلب القائمة وفحص المصادر...';$('out').innerHTML='';$('stats').innerHTML='';const body={type:type.value,tmdb_id:Number($('id').value),season:Number($('season').value),episode:Number($('episode').value)};try{const r=await fetch('/resolve-all',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'فشل الطلب');$('status').textContent='اكتمل الفحص';$('stats').innerHTML='<span class="pill">إجمالي السيرفرات: '+d.servers.length+'</span><span class="pill">مصادر ناجحة: '+d.success_count+'</span>';const rows=d.results.map(x=>'<tr><td>'+x.server+'</td><td class="'+(x.ok?'ok':'bad')+'">'+(x.ok?'نجح':'فشل')+'</td><td>'+(x.stream_url?'<a href="'+x.stream_url+'" target="_blank" rel="noreferrer">فتح الرابط</a><div class="small">'+x.stream_url+'</div>':'<span class="small">'+(x.error||'لا يوجد رابط')+'</span>')+'</td></tr>').join('');$('out').innerHTML='<table><thead><tr><th>السيرفر</th><th>الحالة</th><th>المصدر</th></tr></thead><tbody>'+rows+'</tbody></table>'}catch(err){$('status').textContent='خطأ: '+err.message}finally{btn.disabled=false}};
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS(env) });
    }

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8', ...CORS(env) }
        });
      }

      if (url.pathname === '/health') {
        const stub = getState(env);
        const res = await stub.fetch('https://do/health');
        const data = await res.json();
        return json({ ok: true, wasm: true, ...data }, env);
      }

      if (url.pathname === '/servers') {
        return json({ ok: true, servers: await getServers(env) }, env);
      }

      if (url.pathname === '/resolve' && request.method === 'POST') {
        const body = await request.json();
        const data = await resolvePath(env, sourcePath({
          type: 'movie', ...body, server: body?.server || 'Leon'
        }));
        return json({ ok: true, stream_url: findUrl(data), data }, env);
      }

      if (url.pathname === '/resolve-all' && request.method === 'POST') {
        const body = await request.json();
        if (!['movie', 'tv'].includes(body.type) ||
            !Number.isInteger(Number(body.tmdb_id)) ||
            Number(body.tmdb_id) <= 0 ||
            (body.type === 'tv' &&
              (!Number.isInteger(Number(body.season)) ||
               !Number.isInteger(Number(body.episode)) ||
               Number(body.season) < 1 ||
               Number(body.episode) < 1))) {
          return json({ ok: false, error: 'type, tmdb_id, season and episode are invalid' }, env, { status: 400 });
        }
        return json({ ok: true, ...(await resolveAll(env, body)) }, env);
      }

      return json({ ok: false, error: 'not found' }, env, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: error.message }, env, { status: 502 });
    }
  }
};