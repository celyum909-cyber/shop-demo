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
// Free trial, the yearly plan and Stripe Connect (owner app):
//   GET  /admin/plan       -> trial / paid dates, state and sign-up details (password required)
//   POST /admin/terms      -> records that the owner agreed to the trial terms (password required)
//   POST /admin/plan/checkout -> "Keep your app": saves sign-up details, returns a Stripe page for one year
//   POST /admin/plan/confirm  -> after paying: checks with Stripe, then moves the paid-through date
//   POST /admin/payments/session -> creates the shop's own Stripe account (first time) and opens
//                             Stripe's sign-up form inside the owner app
//   GET  /admin/payments/status  -> asks Stripe whether the shop can take card payments yet
// Mars only (X-Mars-Password header):
//   GET  /mars/plan        -> this shop's plan record and state
//   POST /mars/activate    -> starts the 30-day free trial (body: name, business, email, phone)
//   POST /mars/plan        -> changes dates by hand, e.g. { "paidUntil": "2027-12-02" } for a cash payment
//
// A shop with no trial started (no "plan" record) works exactly as before: checkout uses
// STRIPE_SECRET_KEY directly. Once Mars starts the trial, card payments go to the shop's own
// connected Stripe account, and checkout pauses 3 days after the trial or paid year runs out.
//
// Products and regular prices are read from the shop's own page (the "shop-config" block in
// shop.html), so prices only ever live in one place and customers can't change what they pay.
//
// Cloudflare settings this Worker needs (Settings → Bindings / Variables and Secrets):
//   SHOP               KV namespace binding (variable name exactly SHOP)
//   ADMIN_PASSWORD     Secret — the owner's password (never put it in any file)
//   STRIPE_SECRET_KEY  Secret — sk_test_... while practicing, sk_live_... for real orders
//   SITE_URL           Text   — the full address of shop.html, e.g. https://yourshop.com/shop.html
// For the free trial and yearly plan (only needed once Mars starts a trial):
//   STRIPE_SECRET_KEY  becomes Mars's own key (the same in every shop's Worker), with Connect switched on
//   STRIPE_PUBLISHABLE_KEY Text — Mars's pk_test_... / pk_live_... (shows Stripe's sign-up form in the app)
//   MARS_PASSWORD      Secret — only Mars uses it, to start a trial (different from ADMIN_PASSWORD)
//   YEAR_PRICE         Text   — optional: what one year costs in dollars (600 if not set)

const LIMITS = { title: 80, note: 160, name: 40, email: 120, phone: 30 };
// Photos: one per product (a new upload replaces the old one), JPG/PNG/WebP only,
// 2 MB max each. owner.html shrinks photos to about 1200 px before sending, so most are 100-300 KB.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
// Free trial and yearly plan
const DEFAULT_YEAR_PRICE = 600; // dollars; a YEAR_PRICE setting on the Worker overrides it
const DAY = 864e5, TRIAL_DAYS = 30, GRACE_DAYS = 3, YEAR_DAYS = 365, TRIAL_WARN_DAYS = 7, RENEW_WARN_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    try {
      if (!env.SHOP) return json({ error: 'KV namespace "SHOP" is not bound to this Worker.' }, 500);
      const GET = request.method === 'GET', POST = request.method === 'POST';

      if (GET && path === '/store') {
        const [settings, cfg, plan] = await Promise.all([getSettings(env), loadConfig(env).catch(() => null), getPlan(env).then(p => refreshPayments(env, p))]);
        const products = cfg ? cfg.products.map(p => ({ id: p.id, name: p.name, category: p.category, price: p.price })) : [];
        return json({ ...settings, memberPercent: settings.memberPercent ?? cfg?.members?.percentOff ?? 0, store: cfg ? { name: cfg.store?.name, brandColor: cfg.store?.brandColor } : null, products, ordering: ordering(plan) }, 200, { 'Cache-Control': 'no-store' });
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

      // ----- Free trial, yearly plan and Stripe Connect -----
      if (path.startsWith('/mars/')) {
        if (!(await checkMars(request, env))) return json({ error: 'Wrong Mars password' }, 401);
        const plan = await getPlan(env);
        if (GET && path === '/mars/plan') return json({ plan, ...planState(plan) }, 200, { 'Cache-Control': 'no-store' });
        if (POST && path === '/mars/activate') {
          const b = await request.json().catch(() => ({}));
          if (plan?.trialStart && !b.restart) return json({ error: 'The trial for this shop has already started', plan, ...planState(plan) }, 409);
          const now = Date.now();
          const next = { ...(plan || {}), trialStart: now, trialEnds: now + TRIAL_DAYS * DAY, signup: signupFrom(b, plan?.signup) };
          await putPlan(env, next);
          return json({ ok: true, plan: next, ...planState(next) });
        }
        if (POST && path === '/mars/plan') {
          if (!plan?.trialStart) return json({ error: 'Start the trial first' }, 400);
          const b = await request.json().catch(() => ({})), next = { ...plan };
          for (const k of ['trialEnds', 'paidUntil']) {
            if (!(k in b)) continue;
            if (b[k] === null || b[k] === '') { delete next[k]; continue }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(b[k])) return json({ error: k + ' must look like 2027-12-02' }, 400);
            next[k] = Date.parse(b[k] + 'T23:59:59Z');
          }
          await putPlan(env, next);
          return json({ ok: true, plan: next, ...planState(next) });
        }
        return json({ error: 'Not found' }, 404);
      }

      if (path === '/admin/plan' || path === '/admin/terms' || path.startsWith('/admin/plan/') || path.startsWith('/admin/payments/')) {
        if (!(await checkPassword(request, env))) return denied();
        const plan = await getPlan(env);
        if (GET && path === '/admin/plan') return json(planForOwner(plan, env), 200, { 'Cache-Control': 'no-store' });
        if (!plan?.trialStart) return json({ error: 'This shop has no free trial or plan yet' }, 400);

        if (POST && path === '/admin/terms') {
          const b = await request.json().catch(() => ({}));
          if (b.agree !== true) return json({ error: 'Please tick the box to agree' }, 400);
          const next = { ...plan, termsAgreedAt: plan.termsAgreedAt || Date.now() };
          await putPlan(env, next);
          return json(planForOwner(next, env));
        }

        if (POST && path === '/admin/plan/checkout') {
          const price = yearPrice(env);
          if (!(price > 0) || !env.STRIPE_SECRET_KEY || !env.SITE_URL) return json({ error: 'Signing up is not set up yet. Please contact Mars.' }, 500);
          const b = await request.json().catch(() => ({}));
          const signup = signupFrom(b, {});
          if (!signup.name) return json({ error: 'Please add your name' }, 400);
          if (!signup.business) return json({ error: 'Please add your business name' }, 400);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(signup.email)) return json({ error: 'Please check your email address' }, 400);
          if (b.agree !== true) return json({ error: 'Please tick the box to agree to the service agreement' }, 400);
          const back = sameSite(b.returnUrl, env.SITE_URL);
          if (!back) return json({ error: 'Bad return address' }, 400);
          await putPlan(env, { ...plan, signup, agreedAt: Date.now() });
          const form = new URLSearchParams();
          form.set('mode', 'payment');
          form.set('managed_payments[enabled]', 'false');
          form.set('line_items[0][price_data][currency]', 'usd');
          form.set('line_items[0][price_data][unit_amount]', String(Math.round(price * 100)));
          form.set('line_items[0][price_data][product_data][name]', 'Shop app: one year');
          form.set('line_items[0][price_data][product_data][description]', signup.business);
          form.set('line_items[0][quantity]', '1');
          form.set('customer_email', signup.email);
          form.set('metadata[kind]', 'shop-year');
          form.set('metadata[site]', env.SITE_URL);
          form.set('metadata[business]', signup.business);
          form.set('payment_intent_data[description]', 'Shop app, one year: ' + signup.business);
          form.set('success_url', back + '?plan=paid&session={CHECKOUT_SESSION_ID}');
          form.set('cancel_url', back + '?plan=cancel');
          // Mars's own Stripe account (no Stripe-Account header), so the yearly fee goes to Mars.
          const session = await stripe(env, '/checkout/sessions', { form });
          return json({ url: session.url });
        }

        if (POST && path === '/admin/plan/confirm') {
          const b = await request.json().catch(() => ({}));
          const id = typeof b.session === 'string' ? b.session : '';
          if (!/^cs_[\w]{8,200}$/.test(id)) return json({ error: 'Bad payment reference' }, 400);
          if ((plan.paidSessions || []).some(p => p.id === id)) return json(planForOwner(plan, env));
          const s = await stripe(env, '/checkout/sessions/' + id);
          if (s.metadata?.kind !== 'shop-year' || s.metadata?.site !== env.SITE_URL) return json({ error: 'That payment is not for this shop' }, 400);
          if (s.payment_status !== 'paid') return json({ error: 'The payment has not gone through yet. Please try again in a minute.' }, 409);
          const now = Date.now(), from = Math.max(now, plan.trialEnds || 0, plan.paidUntil || 0);
          const next = { ...plan, paidUntil: from + YEAR_DAYS * DAY, paidSessions: [...(plan.paidSessions || []), { id, at: now, amount: (s.amount_total || 0) / 100 }].slice(-20) };
          await putPlan(env, next);
          return json({ ...planForOwner(next, env), justPaid: true });
        }

        if (POST && path === '/admin/payments/session') {
          if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) return json({ error: 'Payments set-up is not ready yet. Please contact Mars.' }, 500);
          let account = plan.account;
          if (!account) {
            const form = new URLSearchParams();
            // The shop gets its own full Stripe account and pays Stripe's fees itself; Stripe collects
            // the sign-up details. Mars pays no Connect fees for accounts set up this way.
            form.set('controller[stripe_dashboard][type]', 'full');
            form.set('controller[fees][payer]', 'account');
            form.set('controller[losses][payments]', 'stripe');
            form.set('controller[requirement_collection]', 'stripe');
            if (plan.signup?.email) form.set('email', plan.signup.email);
            form.set('business_profile[url]', env.SITE_URL);
            form.set('metadata[site]', env.SITE_URL);
            const acct = await stripe(env, '/accounts', { form });
            account = acct.id;
            await putPlan(env, { ...plan, account });
          }
          const form = new URLSearchParams();
          form.set('account', account);
          form.set('components[account_onboarding][enabled]', 'true');
          const sess = await stripe(env, '/account_sessions', { form });
          return json({ clientSecret: sess.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY });
        }

        if (GET && path === '/admin/payments/status') {
          if (!plan.account) return json({ connected: false, on: false });
          const a = await stripe(env, '/accounts/' + plan.account);
          const due = [...(a.requirements?.currently_due || []), ...(a.requirements?.past_due || [])];
          const on = !!a.charges_enabled;
          if (on !== !!plan.paymentsOn) await putPlan(env, { ...plan, paymentsOn: on });
          return json({ connected: true, on, submitted: !!a.details_submitted, needsMore: due.length > 0, payouts: !!a.payouts_enabled, pending: !!a.requirements?.pending_verification?.length }, 200, { 'Cache-Control': 'no-store' });
        }
        return json({ error: 'Not found' }, 404);
      }

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
      if (err && err.stripe) return json({ error: 'Stripe: ' + err.message }, 502);
      return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
    }
  },
};

// ---------- Checkout ----------
async function checkout(request, env, ctx) {
  if (!env.STRIPE_SECRET_KEY || !env.SITE_URL) return json({ error: 'Checkout is not set up yet' }, 500);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Bad request' }, 400);
  const [cfg, settings, plan] = await Promise.all([loadConfig(env), getSettings(env), getPlan(env).then(p => refreshPayments(env, p))]);
  // Once Mars starts a trial, card payments go to the shop's own Stripe account, and checkout
  // pauses if the trial or paid year has run out (after the grace days).
  const open = ordering(plan);
  if (open === 'paused') return json({ error: 'Ordering is paused right now, please check back soon', ordering: open }, 403);
  if (open === 'setup') return json({ error: 'This shop is still setting up card payments, please check back soon', ordering: open }, 403);
  const account = plan?.trialStart ? plan.account : '';
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
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(account ? { 'Stripe-Account': account } : {}) },
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
  const plan = await getPlan(env), account = plan?.trialStart ? plan.account : '';
  if (plan?.trialStart && !account) return { error: 'Sales show here once card payments are set up' };
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
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions?' + q, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(account ? { 'Stripe-Account': account } : {}) } });
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

// ---------- Free trial and yearly plan ----------
async function getPlan(env) { return (await env.SHOP.get('plan', 'json')) || null }
async function putPlan(env, plan) { await env.SHOP.put('plan', JSON.stringify({ ...plan, updated: Date.now() })) }
// trial -> (paid) -> grace (3 days, still taking orders) -> paused. No plan record = not managed.
function planState(plan, now = Date.now()) {
  if (!plan?.trialStart) return { state: 'none' };
  const trialEnds = plan.trialEnds || 0, paidUntil = plan.paidUntil || 0, endsAt = Math.max(trialEnds, paidUntil);
  const pauseAt = endsAt + GRACE_DAYS * DAY;
  let state = 'paused';
  if (now <= endsAt) state = paidUntil && paidUntil > trialEnds ? 'paid' : 'trial';
  else if (now <= pauseAt) state = 'grace';
  const daysLeft = Math.max(0, Math.ceil((endsAt - now) / DAY)), graceLeft = state === 'grace' ? Math.max(1, Math.ceil((pauseAt - now) / DAY)) : 0;
  const soon = state === 'trial' ? daysLeft <= TRIAL_WARN_DAYS : state === 'paid' ? daysLeft <= RENEW_WARN_DAYS : false;
  return { state, trialStart: plan.trialStart, trialEnds, paidUntil: paidUntil || null, endsAt, pauseAt, daysLeft, graceLeft, soon };
}
// If the owner finished Stripe's sign-up but Stripe approved it later, notice without waiting for the
// owner app: ask Stripe again, at most every 5 minutes, while card payments are still off.
async function refreshPayments(env, plan) {
  if (!plan?.trialStart || !plan.account || plan.paymentsOn || Date.now() - (plan.checkedAt || 0) < 5 * 60e3) return plan;
  try {
    const a = await stripe(env, '/accounts/' + plan.account);
    const next = { ...plan, paymentsOn: !!a.charges_enabled, checkedAt: Date.now() };
    await putPlan(env, next);
    return next;
  } catch { return plan }
}
function ordering(plan) {
  if (!plan?.trialStart) return 'open';
  if (planState(plan).state === 'paused') return 'paused';
  return plan.account && plan.paymentsOn ? 'open' : 'setup';
}
function planForOwner(plan, env) {
  const st = planState(plan);
  if (st.state === 'none') return st;
  return { ...st, yearPrice: yearPrice(env), termsAgreedAt: plan.termsAgreedAt || null, agreedAt: plan.agreedAt || null,
    signup: plan.signup || {}, payments: { connected: !!plan.account, on: !!plan.paymentsOn }, ordering: ordering(plan) };
}
const yearPrice = env => Number(env.YEAR_PRICE) > 0 ? Number(env.YEAR_PRICE) : DEFAULT_YEAR_PRICE;
function signupFrom(b, prev = {}) {
  const pick = (k, max) => (typeof b?.[k] === 'string' ? clean(b[k], max) : prev?.[k] || '');
  return { name: pick('name', 60), business: pick('business', 80), email: pick('email', LIMITS.email).toLowerCase(), phone: pick('phone', LIMITS.phone) };
}
// Only send the owner back to a page on the shop's own site.
function sameSite(u, site) {
  try { const a = new URL(u), b = new URL(site); return a.origin === b.origin && a.protocol === 'https:' || a.origin === b.origin && a.hostname === 'localhost' ? a.origin + a.pathname : '' } catch { return '' }
}
async function stripe(env, path, { form = null, account = '' } = {}) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (account) headers['Stripe-Account'] = account;
  const res = await fetch('https://api.stripe.com/v1' + path, { method: form ? 'POST' : 'GET', headers, body: form || undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data?.error?.message || `error ${res.status}`); e.stripe = true; throw e }
  return data;
}
async function checkMars(request, env) {
  const real = env.MARS_PASSWORD || '';
  if (!real) return false;
  const ok = await sameText(request.headers.get('X-Mars-Password') || '', real);
  if (!ok) await new Promise(r => setTimeout(r, 1000));
  return ok;
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, X-Mars-Password',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(), 'Content-Type': 'application/json', ...extra } });
}
function denied() { return json({ error: 'Wrong password' }, 401); }
