// ======================================================================
// Celyum multi-shop router
// One Worker runs every self-serve shop at  <origin>/<slug>/  (customer app)
// and <origin>/<slug>/owner/ (owner app). Each shop's data lives in the same
// KV namespace under its own prefix "s:<slug>:", so shops never see each other.
// The original single demo shop keeps working on its old root API paths.
//
//   POST /api/signup                 -> creates a shop (name, email, password)
//   *    /api/<slug>/...             -> that shop's API (same routes as before)
//   GET  /api/mars/shops             -> Mars: every shop, its plan and fees earned
//   POST /api/mars/shops/<slug>/reset-password -> Mars: one-time setup code
//   GET  /signup  /mars  /terms      -> pages
//   GET  /<slug>/ ...                -> the shop's pages, manifest, icons
// ======================================================================
const RESERVED = new Set(['api', 'signup', 'mars', 'store', 'join', 'checkout', 'admin', 'login', 'photo', 'terms', 'privacy', 'assets',
  'www', 'app', 'owner', 'help', 'shops', 'static', 'celyum', 'index', 'support', 'about', 'pricing', 'demo', 'test', 'account', 'dashboard']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// The old single-shop API at the root (the original demo shop and its GitHub pages).
const LEGACY = /^\/(store|join|checkout|login|photo\/.+|admin\/.+|mars\/.+)\/?$/;
const SIGNUPS_PER_IP_PER_DAY = 5;

const shopIndexCache = new Map(); // slug -> { rec, at }
async function shopRecord(env, slug) {
  const hit = shopIndexCache.get(slug);
  if (hit && Date.now() - hit.at < 30_000) return hit.rec;
  const rec = await env.SHOP.get('shopidx:' + slug, 'json');
  shopIndexCache.set(slug, { rec, at: Date.now() });
  return rec;
}

// The shop's own slice of KV: every key gets the "s:<slug>:" prefix.
function prefixKV(kv, P) {
  return {
    get: (k, t) => kv.get(P + k, t),
    getWithMetadata: (k, t) => kv.getWithMetadata(P + k, t),
    put: (k, v, o) => kv.put(P + k, v, o),
    delete: k => kv.delete(P + k),
    list: async (o = {}) => {
      const r = await kv.list({ ...o, prefix: P + (o.prefix || '') });
      return { ...r, keys: r.keys.map(k => ({ ...k, name: k.name.slice(P.length) })) };
    },
  };
}
function originOf(url, env) { return (env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, '') }
function tenantEnv(env, slug, origin, rec) {
  // ADMIN_PASSWORD here is only a one-time setup code Mars made (after a reset); normally empty.
  return { ...env, SHOP: prefixKV(env.SHOP, `s:${slug}:`), SITE_URL: `${origin}/${slug}/`, API_BASE: `${origin}/api/${slug}`, ADMIN_PASSWORD: rec?.setupCode || '', TENANT: slug };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    try {
      if (!env.SHOP) return json({ error: 'KV namespace "SHOP" is not bound to this Worker.' }, 500);
      const origin = originOf(url, env);

      // ----- global API -----
      if (path === '/api/signup') return request.method === 'POST' ? signup(request, env, origin, ctx) : json({ error: 'Not found' }, 404);
      if (path.startsWith('/api/mars/')) return marsApi(request, env, path.slice('/api/mars'.length));

      // ----- one shop's API -----
      let m = path.match(/^\/api\/([a-z0-9-]+)(\/.*)?$/);
      if (m) {
        const rec = await shopRecord(env, m[1]);
        if (!rec) return json({ error: 'Shop not found' }, 404);
        const inner = new URL(url); inner.pathname = m[2] || '/';
        return core.fetch(new Request(inner.toString(), request), tenantEnv(env, m[1], origin, rec), ctx);
      }

      // ----- the original demo shop's API at the root -----
      if (LEGACY.test(path)) return core.fetch(request, env, ctx);

      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Not found' }, 404);

      // ----- global pages -----
      if (path === '/') return Response.redirect(origin + '/signup', 302);
      if (path === '/signup' || path === '/signup/') return page('signup.html');
      if (path === '/mars' || path === '/mars/') return page('mars-admin.html');
      if (path === '/terms' || path === '/terms/' || path === '/terms.html') return page('terms.html');
      if (path === '/favicon.ico') return asset('icon-192.png');

      // ----- a shop's pages -----
      m = path.match(/^\/([a-z0-9-]+)(\/.*)?$/);
      if (m && !RESERVED.has(m[1])) {
        const slug = m[1], rest = m[2] || '';
        const rec = await shopRecord(env, slug);
        if (!rec) return notFoundPage();
        if (!rest) return Response.redirect(`${origin}/${slug}/`, 301);
        if (rest === '/owner') return Response.redirect(`${origin}/${slug}/owner/`, 301);
        return shopPage(env, slug, rest, origin, rec);
      }
      return notFoundPage();
    } catch (err) {
      return json({ error: err.stripe ? 'Stripe: ' + err.message : 'Something went wrong: ' + err.message }, 500);
    }
  },
};

// ---------- signup ----------
async function signup(request, env, origin, ctx) {
  const b = await request.json().catch(() => ({}));
  const t = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const name = t(b.shop, 60), owner = t(b.owner, 60), email = t(b.email, 120).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
  if (name.length < 2) return json({ error: "Type your shop's name" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Type a valid email address' }, 400);
  if (password.length < 8) return json({ error: 'Your password needs at least 8 characters' }, 400);
  if (password.length > 200) return json({ error: 'That password is too long' }, 400);
  if (!b.agree) return json({ error: 'Please agree to the terms to continue' }, 400);

  // Slow down abuse: a few signups per network per day.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:signup:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const tries = Number(await env.SHOP.get(rlKey)) || 0;
  if (tries >= SIGNUPS_PER_IP_PER_DAY) return json({ error: 'Too many new shops from this network today. Please try again tomorrow.' }, 429);
  await env.SHOP.put(rlKey, String(tries + 1), { expirationTtl: 60 * 60 * 26 });

  // The shop's address: from the name, made unique.
  let base = (t(b.slug, 40) || name).toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');
  if (!base || base.length < 2) base = 'shop';
  if (RESERVED.has(base)) base += '-shop';
  let slug = '';
  for (let i = 1; i <= 30 && !slug; i++) {
    const tryS = i === 1 ? base : `${base}-${i}`;
    if (SLUG_RE.test(tryS) && !(await env.SHOP.get('shopidx:' + tryS))) slug = tryS;
  }
  if (!slug) return json({ error: 'That name is taken. Try a slightly different one.' }, 409);

  const now = Date.now();
  const te = tenantEnv(env, slug, origin, null);
  await te.SHOP.put('config', JSON.stringify(starterConfig(name, email)));
  await saveOwnerPassword(te, password);
  await te.SHOP.put('plan', JSON.stringify({ activatedAt: now, termsAgreedAt: now, signup: { name: owner, business: name, email, phone: '', at: now } }));
  const rec = { name, email, owner, created: now };
  await env.SHOP.put('shopidx:' + slug, JSON.stringify(rec), { metadata: { name, email, created: now } });
  shopIndexCache.set(slug, { rec, at: now });
  // Emails (once Resend is set up): a welcome to the owner, and a heads-up to Mars.
  if (env.RESEND_API_KEY) {
    const shopUrl = `${origin}/${slug}/`, ownerUrl = `${origin}/${slug}/owner/`, from = `Celyum Shops <${env.MAIL_FROM || MAIL_DOMAIN_FROM}>`;
    const mails = [
      { from, to: [email], reply_to: env.MARS_EMAIL || 'marcelo@celyumdigitalsolutions.com', subject: `${name} is ready`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#0e1a2b;max-width:560px"><p>Hi ${escHtml(owner || 'there')},</p><p>Your shop app is live. Here's what to do next:</p><ol><li>Open your <a href="${ownerUrl}">owner app</a> and add your products.</li><li>Tap <b>Set up payments</b> so customers can pay by card.</li><li>Print your counter sign from <b>Your QR codes</b>.</li></ol><p>Your shop: <a href="${shopUrl}">${shopUrl}</a><br>Your owner app: <a href="${ownerUrl}">${ownerUrl}</a> (keep this one private)</p><p>Questions? Just reply to this email.</p><p>Mars · Celyum Digital</p></div>` },
      { from, to: [env.MARS_EMAIL || 'marcelo@celyumdigitalsolutions.com'], subject: `New shop: ${name}`,
        html: `<p><b>${escHtml(name)}</b> just signed up.</p><p>Owner: ${escHtml(owner || '–')} · ${escHtml(email)}<br>Shop: <a href="${shopUrl}">${shopUrl}</a></p><p><a href="${origin}/mars">Open your dashboard</a></p>` },
    ];
    ctx?.waitUntil(resend(env, '/emails/batch', mails).catch(() => {}));
  }
  return json({ ok: true, slug, shopUrl: `${origin}/${slug}/`, ownerUrl: `${origin}/${slug}/owner/` });
}

// ---------- Mars: every shop at a glance ----------
async function marsApi(request, env, sub) {
  if (!(await checkMars(request, env))) return json({ error: 'Wrong Mars password' }, 401);
  if (request.method === 'GET' && sub === '/shops') {
    const shops = [];
    let cursor;
    do {
      const page = await env.SHOP.list({ prefix: 'shopidx:', cursor });
      for (const k of page.keys) shops.push({ slug: k.name.slice(8), ...(k.metadata || {}) });
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor && shops.length < 1000);
    shops.sort((a, b) => (b.created || 0) - (a.created || 0));
    const top = shops.slice(0, 200);
    const plans = await Promise.all(top.map(s => env.SHOP.get(`s:${s.slug}:plan`, 'json')));
    const pws = await Promise.all(top.map(s => env.SHOP.get(`s:${s.slug}:owner-password`)));
    // Fees collected in the last 30 days, per connected account (one Stripe call).
    const fees = {}; let feeError = '';
    if (env.STRIPE_SECRET_KEY) {
      try {
        let after = '', pages = 0;
        const since = Math.floor((Date.now() - 30 * DAY) / 1000);
        while (pages < 5) {
          const q = new URLSearchParams({ limit: '100', 'created[gte]': String(since) });
          if (after) q.set('starting_after', after);
          const d = await stripe(env, '/application_fees?' + q);
          for (const f of d.data) { const a = typeof f.account === 'string' ? f.account : f.account?.id; const x = fees[a] ||= { amount: 0, count: 0 }; x.amount += (f.amount - (f.amount_refunded || 0)) / 100; x.count++ }
          pages++;
          if (!d.has_more || !d.data.length) break;
          after = d.data[d.data.length - 1].id;
        }
      } catch (e) { feeError = e.message }
    }
    const rows = top.map((s, i) => {
      const p = plans[i] || {}, st = planState(p), f = fees[p.account] || { amount: 0, count: 0 };
      return { ...s, state: st.state, proUntil: st.proCurrentPeriodEnd || null, payments: p.account ? (p.paymentsOn ? 'on' : 'started') : 'none',
        ownerPassword: !!pws[i], fees30: Math.round(f.amount * 100) / 100, feeOrders30: f.count };
    });
    const total = rows.reduce((a, r) => a + r.fees30, 0);
    return json({ shops: rows, count: shops.length, fees30: Math.round(total * 100) / 100, pro: rows.filter(r => r.state === 'pro').length, feeError }, 200, { 'Cache-Control': 'no-store' });
  }
  const m = sub.match(/^\/shops\/([a-z0-9-]+)\/reset-password$/);
  if (request.method === 'POST' && m) {
    const rec = await env.SHOP.get('shopidx:' + m[1], 'json');
    if (!rec) return json({ error: 'Shop not found' }, 404);
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789', bytes = crypto.getRandomValues(new Uint8Array(10));
    const code = [...bytes].map(x => abc[x % abc.length]).join('');
    await env.SHOP.delete(`s:${m[1]}:owner-password`);
    const next = { ...rec, setupCode: code, setupCodeAt: Date.now() };
    await env.SHOP.put('shopidx:' + m[1], JSON.stringify(next), { metadata: { name: rec.name, email: rec.email, created: rec.created } });
    shopIndexCache.delete(m[1]);
    return json({ ok: true, code });
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- pages ----------
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png', webmanifest: 'application/manifest+json', svg: 'image/svg+xml' };
function typeOf(name) { return TYPES[name.split('.').pop()] || 'application/octet-stream' }
function page(name, body) {
  return new Response(body ?? PAGES[name], { headers: { 'Content-Type': typeOf(name), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' } });
}
function asset(name) {
  const b64 = PAGES[name]; if (b64 == null) return notFoundPage();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': typeOf(name), 'Cache-Control': 'public, max-age=86400' } });
}
function notFoundPage() {
  return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>Shop not found</h1><p>Check the address, or <a href="/signup">start your own shop</a>.</p>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
const escJson = o => JSON.stringify(o).replace(/</g, '\\u003c');
async function shopConfigFor(env, slug, origin) {
  const te = tenantEnv(env, slug, origin, null);
  const cfg = await loadConfig(te);
  return { ...cfg, api: `${origin}/api/${slug}`, store: { ...cfg.store, slug, shareUrl: `${origin}/${slug}/` }, privacy: { ...(cfg.privacy || {}), page: 'privacy.html', host: 'Cloudflare' }, demo: null };
}
async function shopPage(env, slug, rest, origin, rec) {
  if (rest === '/' || rest === '/index.html' || rest === '/shop.html') {
    const cfg = await shopConfigFor(env, slug, origin);
    const html = PAGES['shop.html'].replace(/(<script[^>]*id=["']shop-config["'][^>]*>)[\s\S]*?(<\/script>)/i, (_, a, b) => a + escJson(cfg) + b)
      .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(cfg.store.name)}</title>`)
      .replace('href="apple-touch-icon.png"', `href="apple-touch-icon.png${cfg.store.logo ? '?' + (cfg.store.logo.split('?')[1] || '') : ''}"`);
    return page('shop.html', html);
  }
  if (rest === '/privacy.html') return page('privacy.html');
  if (rest === '/sw.js') return page('sw.js');
  if (rest === '/owner.html') return Response.redirect(`${origin}/${slug}/owner/`, 301);
  if (rest === '/manifest.webmanifest' || rest === '/owner/manifest.webmanifest') {
    const cfg = await shopConfigFor(env, slug, origin), owner = rest.startsWith('/owner');
    const color = cfg.store.brandColor || '#072448', name = cfg.store.name || 'Shop';
    const icon = owner ? '../owner-icon' : 'icon';
    const v = !owner && cfg.store.logo ? '?' + (cfg.store.logo.split('?')[1] || '') : '';
    const m = { name: owner ? `${name} Owner` : name, short_name: owner ? 'Owner' : name.slice(0, 12), description: owner ? `Run ${name}: drops, sales, products, orders and members.` : `${name}: shop, member prices, drops and rewards.`,
      id: './', start_url: './', scope: './', display: 'standalone', background_color: color, theme_color: color,
      icons: [{ src: `${icon}-192.png${v}`, sizes: '192x192', type: 'image/png' }, { src: `${icon}-512.png${v}`, sizes: '512x512', type: 'image/png' }, { src: `${icon}-maskable-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
    return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } });
  }
  if (rest === '/owner/') {
    const html = PAGES['owner.html'].replace("const SHOP_API = '';", `const SHOP_API = ${JSON.stringify(`${origin}/api/${slug}`)}; const SHOP_SLUG = ${JSON.stringify(slug)}; const SHOP_URL = ${JSON.stringify(`${origin}/${slug}/`)};`);
    return page('owner.html', html);
  }
  if (rest === '/owner/sw.js') return page('owner-sw.js');
  const file = rest.slice(1);
  // the shop's own logo, when the owner uploaded one
  const LOGO = { 'icon-512.png': '512', 'icon-maskable-512.png': 'maskable', 'icon-192.png': '192', 'apple-touch-icon.png': '180' };
  if (LOGO[file]) {
    const kv = tenantEnv(env, slug, origin, null).SHOP;
    const img = await kv.get('logo:' + LOGO[file], 'arrayBuffer');
    if (img) return new Response(img, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' } });
  }
  if (/^(icon-192|icon-512|icon-maskable-512|apple-touch-icon|owner-icon-192|owner-icon-512|owner-icon-maskable-512|owner-apple-touch-icon)\.png$/.test(file)) return asset(file);
  return notFoundPage();
}
