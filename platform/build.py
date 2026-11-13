#!/usr/bin/env python3
"""Builds platform/dist/worker.js: the one multi-shop Worker.

It joins the shop Worker (shop-worker.js), every page and icon the shops need,
and the router (platform/router.js) into a single file you paste into Cloudflare.
Run from the repo root:  python3 platform/build.py
"""
import base64, json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
P = ROOT / 'platform'

def read(p): return (ROOT / p).read_text(encoding='utf-8')
def must_replace(text, old, new, label):
    if old not in text: raise SystemExit(f'build: could not find {label}')
    return text.replace(old, new, 1)

core = read('shop-worker.js')
core = must_replace(core, 'export default {', 'const core = {', 'export default in shop-worker.js')

shop = read('shop.html')
shop = must_replace(shop, "const KEY = 'shop:' + (S.name || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-') + ':';",
                    "const KEY = 'shop:' + (S.slug || (S.name || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-')) + ':';", 'shop storage key')

m = re.search(r'<!-- QR codes: qrcode-generator[^\n]*\n<script>var qrcode=.*?</script>', shop, re.S)
if not m: raise SystemExit('build: qrcode library not found in shop.html')
qrlib = m.group(0)

owner = read('owner/index.html')
owner, n = re.subn(r"const SHOP_API = '[^']*';", "const SHOP_API = '';", owner, count=1)
if not n: raise SystemExit('build: SHOP_API line not found in owner/index.html')
owner = must_replace(owner, "<script>\n'use strict';", qrlib + "\n<script>\n'use strict';", 'owner main script')

terms = must_replace(read('terms.html'), '<a class="back" href="owner/">', '<a class="back" href="javascript:history.back()">', 'terms back link')

pages = {
    'shop.html': shop,
    'owner.html': owner,
    'privacy.html': read('privacy.html'),
    'terms.html': terms,
    'signup.html': read('platform/signup.html'),
    'mars-admin.html': read('platform/mars-admin.html'),
    'sw.js': read('sw.js'),
    'owner-sw.js': read('owner/sw.js'),
}
for f in ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
          'owner-icon-192.png', 'owner-icon-512.png', 'owner-icon-maskable-512.png', 'owner-apple-touch-icon.png']:
    pages[f] = base64.b64encode((ROOT / f).read_bytes()).decode()

router = read('platform/router.js').replace('export default {', 'export default {', 1)
out = ('// Celyum multi-shop Worker. BUILT FILE: edit shop-worker.js, the pages, or platform/router.js,\n'
       '// then run  python3 platform/build.py  and paste platform/dist/worker.js into Cloudflare.\n\n'
       + core + '\n\n// ---------- bundled pages and icons ----------\nconst PAGES = '
       + json.dumps(pages, ensure_ascii=False).replace('</script', '<\\/script') + ';\n\n' + router)
(P / 'dist').mkdir(exist_ok=True)
(P / 'dist' / 'worker.js').write_text(out, encoding='utf-8')
print(f'built platform/dist/worker.js ({len(out.encode()) // 1024} KB)')
