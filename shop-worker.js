// Shop template — backend (Cloudflare Worker, free plan)
//
// One copy of this Worker runs each shop. It:
//   GET  /store            -> this week's drop, sale prices, member discount, product list (public)
//   POST /join             -> adds a customer to the member list
//   POST /checkout         -> builds a Stripe checkout page from the cart and returns its address
//   POST /login            -> checks the owner password (owner.html)
//   POST /admin/settings   -> saves the drop, sale prices and member discount (password required)
//   GET  /admin/members    -> the member list (password required)
//   POST /admin/member/remove -> deletes one member, e.g. when they ask (password required)
//   GET  /admin/stats      -> sales numbers for the owner, read from Stripe (password required)
//   POST /admin/photo      -> uploads or removes a product photo (password required)
//   GET  /photo/<id>       -> a product photo (public)
//
// Products and regular prices are read from the shop's own page (the "shop-config" block in
// shop.html), so prices only ever live in one place and customers can't change what they pay.
//
// Cloudflare settings this Worker needs (Settings → Bindings / Variables and Secrets):
//   SHOP               KV namespace binding (variable name exactly SHOP)
//   ADMIN_PASSWORD     Secret — the owner's password (never put it in any file)
//   STRIPE_SECRET_KEY  Secret — sk_test_... while practicing, sk_live_... for real orders
//   SITE_URL           Text   — the full address of shop.html, e.g. https://yourshop.com/shop.html

const LIMITS = { title: 80, note: 160, name: 40, email: 120, phone: 30 };
// Photos: one per product (a new upload replaces the old one), JPG/PNG/WebP only,
// 2 MB max each. owner.html shrinks photos to about 1200 px before sending, so most are 100-300 KB.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    try {
      if (!env.SHOP) return json({ error: 'KV namespace "SHOP" is not bound to this Worker.' }, 500);
      const GET = request.method === 'GET', POST = request.method === 'POST';

      if (GET && path === '/store') {
        const [settings, cfg] = await Promise.all([getSettings(env), loadConfig(env).catch(() => null)]);
        const products = cfg ? cfg.products.map(p => ({ id: p.id, name: p.name, category: p.category, price: p.price })) : [];
        return json({ ...settings, memberPercent: settings.memberPercent ?? cfg?.members?.percentOff ?? 0, store: cfg ? { name: cfg.store?.name, brandColor: cfg.store?.brandColor } : null, products }, 200, { 'Cache-Control': 'no-store' });
      }

      if (POST && path === '/join') {
        const b = await request.json().catch(() => ({}));
        const name = clean(b.name, LIMITS.name), email = clean(b.email, LIMITS.email).toLowerCase(), phone = clean(b.phone, LIMITS.phone);
        if (!name) return json({ error: 'Please add your first name' }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'Please check your email address' }, 400);
        const key = 'member:' + email, existing = await env.SHOP.get(key, 'json');
        await env.SHOP.put(key, JSON.stringify({ name, email, phone, since: existing?.since || Date.now() }));
        return json({ ok: true });
      }

      if (POST && path === '/checkout') return checkout(request, env, ctx);

      if (GET && path.startsWith('/photo/')) {
        const id = decodeURIComponent(path.slice(7));
        if (!/^[\w-]{1,60}$/.test(id)) return json({ error: 'Not found' }, 404);
        // Serve from Cloudflare's cache when possible, so repeat views don't use up KV reads.
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const hit = cache && await cache.match(request);
        if (hit) return hit;
        const { value, metadata } = await env.SHOP.getWithMetadata('photo:' + id, 'arrayBuffer');
        if (!value) return new Response('No photo', { status: 404, headers: cors() });
        // the app adds ?v=<upload time>, so a new photo shows right away
        const res = new Response(value, { headers: { ...cors(), 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
        if (cache && url.searchParams.get('v')) ctx?.waitUntil(cache.put(request, res.clone()));
        return res;
      }

      if (POST && path === '/admin/photo') {
        if (!(await checkPassword(request, env))) return denied();
        const form = await request.formData();
        const id = String(form.get('id') || '');
        const cfg = await loadConfig(env);
        if (!cfg.products.some(p => p.id === id)) return json({ error: 'Unknown product' }, 400);
        const settings = await getSettings(env), photos = { ...(settings.photos || {}) };
        if (form.get('remove') === '1') {
          await env.SHOP.delete('photo:' + id);
          delete photos[id];
        } else {
          const file = form.get('image');
          if (!file || typeof file !== 'object' || !file.size) return json({ error: 'No photo was sent' }, 400);
          if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return json({ error: 'Photo must be JPG, PNG or WebP' }, 400);
          if (file.size > MAX_PHOTO_BYTES) return json({ error: 'Photo is too large (2 MB max)' }, 400);
          await env.SHOP.put('photo:' + id, await file.arrayBuffer(), { metadata: { type: file.type } });
          photos[id] = Date.now();
        }
        const next = { ...(await getSettings(env)), photos, updated: Date.now() };
        await env.SHOP.put('settings', JSON.stringify(next));
        return json({ ok: true, photos });
      }

      if (POST && path === '/login') {
        if (!(await checkPassword(request, env))) return denied();
        return json({ ok: true });
      }

      if (POST && path === '/admin/settings') {
        if (!(await checkPassword(request, env))) return denied();
        const b = await request.json().catch(() => null);
        if (!b) return json({ error: 'Bad request' }, 400);
        const cfg = await loadConfig(env);
        const byId = Object.fromEntries(cfg.products.map(p => [p.id, p]));
        const current = await getSettings(env), next = { ...current };

        if ('drop' in b) {
          if (!b.drop) next.drop = null;
          else {
            const d = b.drop, p = byId[d.id], price = Number(d.price);
            if (!p) return json({ error: 'Pick a product for the drop' }, 400);
            if (!(price > 0 && price < p.price)) return json({ error: `Drop price must be below the regular price (${p.price})` }, 400);
            if (d.ends && !/^\d{4}-\d{2}-\d{2}$/.test(d.ends)) return json({ error: 'End date looks wrong' }, 400);
            next.drop = { id: p.id, price: round2(price), title: clean(d.title, LIMITS.title), note: clean(d.note, LIMITS.note), ends: d.ends || '', membersOnly: !!d.membersOnly };
          }
        }
        if ('sales' in b) {
          const sales = {};
          for (const [id, v] of Object.entries(b.sales || {})) {
            const p = byId[id], price = Number(v);
            if (!p || !(price > 0)) continue;
            if (price >= p.price) return json({ error: `${p.name}: sale price must be below ${p.price}` }, 400);
            sales[id] = round2(price);
          }
          next.sales = sales;
        }
        if ('memberPercent' in b) {
          const pct = Number(b.memberPercent);
          if (!(pct >= 0 && pct <= 50)) return json({ error: 'Member discount must be between 0 and 50%' }, 400);
          next.memberPercent = Math.round(pct);
        }
        next.updated = Date.now();
        await env.SHOP.put('settings', JSON.stringify(next));
        return json({ ok: true, settings: next });
      }

      if (GET && path === '/admin/stats') {
        if (!(await checkPassword(request, env))) return denied();
        return json(await salesStats(env, url), 200, { 'Cache-Control': 'no-store' });
      }

      if (POST && path === '/admin/member/remove') {
        if (!(await checkPassword(request, env))) return denied();
        const b = await request.json().catch(() => ({}));
        const email = clean(b.email, LIMITS.email).toLowerCase();
        if (!email) return json({ error: 'No email given' }, 400);
        await env.SHOP.delete('member:' + email);
        return json({ ok: true });
      }

      if (GET && path === '/admin/members') {
        if (!(await checkPassword(request, env))) return denied();
        const members = [];
        let cursor;
        do {
          const page = await env.SHOP.list({ prefix: 'member:', cursor });
          const vals = await Promise.all(page.keys.map(k => env.SHOP.get(k.name, 'json')));
          members.push(...vals.filter(Boolean));
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        members.sort((a, b) => (b.since || 0) - (a.since || 0));
        return json({ count: members.length, members }, 200, { 'Cache-Control': 'no-store' });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
    }
  },
};

// ---------- Checkout ----------
async function checkout(request, env, ctx) {
  if (!env.STRIPE_SECRET_KEY || !env.SITE_URL) return json({ error: 'Checkout is not set up yet' }, 500);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Bad request' }, 400);
  const [cfg, settings] = await Promise.all([loadConfig(env), getSettings(env)]);
  const byId = Object.fromEntries(cfg.products.map(p => [p.id, p]));
  const memberPercent = settings.memberPercent ?? cfg.members?.percentOff ?? 0;

  // A member discount only applies if the email is really on the member list.
  let memberEmail = '';
  if (cfg.members?.enabled && typeof body.memberEmail === 'string' && body.memberEmail) {
    const email = body.memberEmail.trim().toLowerCase();
    if (await env.SHOP.get('member:' + email)) memberEmail = email;
  }

  const form = new URLSearchParams();
  let n = 0;
  for (const it of (Array.isArray(body.items) ? body.items.slice(0, 40) : [])) {
    const p = byId[it.id], qty = Math.floor(Number(it.qty)), sizes = p?.sizes?.length ? p.sizes : ['One size'];
    if (!p || !sizes.includes(it.size) || !(qty >= 1 && qty <= 20)) continue;
    const { price, why } = priceOf(p, settings, memberPercent, cfg, !!memberEmail);
    form.set(`line_items[${n}][price_data][currency]`, (cfg.store?.currency || 'usd').toLowerCase());
    form.set(`line_items[${n}][price_data][unit_amount]`, String(Math.round(price * 100)));
    form.set(`line_items[${n}][price_data][product_data][name]`, sizes.length > 1 ? `${p.name} (${it.size})` : p.name);
    const label = { sale: 'Sale price', drop: "This week's drop", member: 'Member price' }[why];
    if (label) form.set(`line_items[${n}][price_data][product_data][description]`, label);
    form.set(`line_items[${n}][quantity]`, String(qty));
    n++;
  }
  if (!n) return json({ error: 'Your cart is empty' }, 400);

  const ship = body.fulfilment === 'ship' && cfg.shipping?.enabled;
  const site = env.SITE_URL;
  const back = typeof body.returnUrl === 'string' && body.returnUrl.startsWith(site) ? body.returnUrl : site;
  form.set('mode', 'payment');
  // Physical goods: turn off Stripe Managed Payments (it's for digital products and requires tax codes).
  form.set('managed_payments[enabled]', 'false');
  form.set('success_url', `${back}?checkout=success&order={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${back}?checkout=cancel`);
  form.set('phone_number_collection[enabled]', 'true');
  if (memberEmail) form.set('customer_email', memberEmail);
  form.set('metadata[fulfilment]', ship ? 'ship' : 'pickup');
  form.set('metadata[member]', memberEmail ? 'yes' : 'no');
  form.set('payment_intent_data[description]', ship ? 'Order - SHIP' : 'Order - PICKUP IN STORE');
  if (ship) {
    form.set('shipping_address_collection[allowed_countries][0]', 'US');
    form.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    form.set('shipping_options[0][shipping_rate_data][display_name]', 'Standard shipping');
    form.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Math.round(Number(cfg.shipping.flat || 0) * 100)));
    form.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', (cfg.store?.currency || 'usd').toLowerCase());
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const session = await res.json();
  if (!res.ok) return json({ error: session?.error?.message || 'Stripe error' }, 502);
  // Count checkouts started per day, so the owner can see how many finish.
  const startedKey = 'stats:started:' + new Date().toISOString().slice(0, 10);
  const bump = Promise.all([
    env.SHOP.get(startedKey).then(v => env.SHOP.put(startedKey, String((Number(v) || 0) + 1), { expirationTtl: 400 * 86400 })),
    // Remember when counting began, so orders from before then don't skew the finish rate.
    env.SHOP.get('stats:since').then(v => v || env.SHOP.put('stats:since', String(Date.now()))),
  ]);
  if (ctx?.waitUntil) ctx.waitUntil(bump); else await bump;
  return json({ url: session.url });
}

// Same rule as the app: the customer pays the single lowest price they qualify for. Deals don't stack.
function priceOf(p, settings, memberPercent, cfg, isMember) {
  let price = p.price, why = '';
  const sale = Number(settings.sales?.[p.id]);
  if (sale > 0 && sale < price) { price = sale; why = 'sale' }
  const d = settings.drop;
  const dropLive = d && d.id === p.id && d.price > 0 && (!d.ends || Date.now() <= new Date(d.ends + 'T23:59:59').getTime() + 14 * 3600e3);
  if (dropLive && (!d.membersOnly || isMember) && d.price < price) { price = d.price; why = 'drop' }
  if (isMember && cfg.members?.enabled) {
    const mp = p.memberPrice > 0 ? p.memberPrice : memberPercent > 0 ? round2(p.price * (1 - memberPercent / 100)) : Infinity;
    if (mp < price) { price = mp; why = 'member' }
  }
  return { price: round2(price), why };
}


// ---------- Owner sales numbers (read from Stripe, nothing extra to set up) ----------
// Only checkouts made by this shop app count (they carry metadata "fulfilment").
async function salesStats(env, url) {
  if (!env.STRIPE_SECRET_KEY) return { error: 'Stripe is not connected yet' };
  const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
  const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0)); // owner's offset in minutes (from getTimezoneOffset)
  const dayOf = ms => new Date(ms - tz * 60000).toISOString().slice(0, 10);
  const now = Date.now();
  // Start at local midnight `days-1` days ago, so "7 days" means today plus the 6 days before.
  const todayStart = Date.parse(dayOf(now) + 'T00:00:00Z') + tz * 60000;
  const since = todayStart - (days - 1) * 86400000;

  const sessions = [];
  let after = '', pages = 0, livemode = null;
  while (pages < 10) {
    const q = new URLSearchParams({ status: 'complete', limit: '100', 'created[gte]': String(Math.floor(since / 1000)) });
    q.append('expand[]', 'data.line_items');
    if (after) q.set('starting_after', after);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions?' + q, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    const page = await res.json();
    if (!res.ok) return { error: page?.error?.message || 'Could not read sales from Stripe' };
    for (const s of page.data) { livemode ??= s.livemode; if (s.metadata?.fulfilment && s.payment_status === 'paid') sessions.push(s) }
    pages++;
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }

  const byDay = {};
  for (let t = since; t <= now; t += 86400000) byDay[dayOf(t)] = { date: dayOf(t), revenue: 0, orders: 0 };
  const products = {};
  let revenue = 0, items = 0, pickup = 0, ship = 0, memberOrders = 0, currency = 'usd';
  for (const s of sessions) {
    const total = (s.amount_total || 0) / 100;
    currency = s.currency || currency;
    revenue += total;
    const d = byDay[dayOf(s.created * 1000)]; if (d) { d.revenue += total; d.orders++ }
    if (s.metadata.fulfilment === 'ship') ship++; else pickup++;
    if (s.metadata.member === 'yes') memberOrders++;
    for (const li of s.line_items?.data || []) {
      const name = String(li.description || 'Item').replace(/\s*\([^)]*\)\s*$/, '');
      const p = products[name] ||= { name, units: 0, revenue: 0 };
      p.units += li.quantity || 0; p.revenue += (li.amount_total || 0) / 100; items += li.quantity || 0;
    }
  }

  // Checkouts started (counted by this Worker) and members who joined in the period.
  const dayKeys = Object.keys(byDay);
  const startedCounts = await Promise.all(dayKeys.map(k => env.SHOP.get('stats:started:' + k)));
  const started = startedCounts.reduce((a, v) => a + (Number(v) || 0), 0);
  // Orders placed after counting began: these are the ones the finish rate compares with "started".
  const trackSince = Number(await env.SHOP.get('stats:since')) || Infinity;
  const finished = sessions.filter(s => s.created * 1000 >= trackSince).length;
  let newMembers = 0, cursor;
  do {
    const page = await env.SHOP.list({ prefix: 'member:', cursor });
    const vals = await Promise.all(page.keys.map(k => env.SHOP.get(k.name, 'json')));
    newMembers += vals.filter(m => m && m.since >= since).length;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const r2 = n => Math.round(n * 100) / 100;
  return {
    days, currency, testMode: livemode === false, truncated: pages >= 10,
    revenue: r2(revenue), orders: sessions.length, items, avgOrder: sessions.length ? r2(revenue / sessions.length) : 0,
    pickup, ship, memberOrders, started, finished, newMembers,
    byDay: Object.values(byDay).map(d => ({ ...d, revenue: r2(d.revenue) })),
    top: Object.values(products).map(p => ({ ...p, revenue: r2(p.revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
  };
}

// ---------- Helpers ----------
let cached = null, cachedAt = 0;
async function loadConfig(env) {
  if (cached && Date.now() - cachedAt < 60_000) return cached;
  if (!env.SITE_URL) throw new Error('SITE_URL is not set');
  const res = await fetch(env.SITE_URL, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(`Could not load the shop page (${res.status})`);
  const html = await res.text();
  const m = html.match(/<script[^>]*id=["']shop-config["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('shop-config block not found on the shop page');
  const cfg = JSON.parse(m[1]);
  if (!Array.isArray(cfg.products)) throw new Error('shop-config has no products');
  cached = cfg; cachedAt = Date.now();
  return cfg;
}
async function getSettings(env) {
  return (await env.SHOP.get('settings', 'json')) || { drop: null, sales: {}, memberPercent: null, photos: {}, updated: 0 };
}
const round2 = n => Math.round(n * 100) / 100;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function checkPassword(request, env) {
  const given = request.headers.get('X-Admin-Password') || '';
  const real = env.ADMIN_PASSWORD || '';
  if (!real) return false;
  const ok = await sameText(given, real);
  if (!ok) await new Promise(r => setTimeout(r, 1000)); // slows down password guessing
  return ok;
}
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(), 'Content-Type': 'application/json', ...extra } });
}
function denied() { return json({ error: 'Wrong password' }, 401); }
