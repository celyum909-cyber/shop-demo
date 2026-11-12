# Shop template: setting up a new shop

Three parts make one shop:

| File | Who uses it | What it is |
| --- | --- | --- |
| `shop.html` | Customers | The phone app: shop, weekly drop, sales, cart, checkout, rewards card, members |
| `owner/` folder | The shop owner | Sign in to set the weekly drop, sale prices and member discount, and see members |
| `shop-worker.js` | Runs on Cloudflare | Checkout with Stripe, saves the owner's settings, keeps the member list |

The app works on its own in **practice mode** (no Worker, no card charged), so you can demo it before any setup.

---

## 1. Make it theirs (about 15 minutes)

Open `shop.html` in a text editor. Everything you change is in the **SHOP SETTINGS** block at the top. Nothing below it needs editing.

- **store**: name, tagline, 2-letter `initials`, `brandColor` (any color code, e.g. `#b5432f`), address, hours, phone, email. To use a real logo, put its web address in `logo`.
  - `shareUrl`: the address the **Share the shop** QR code and button point to (Members tab), e.g. `https://yourname.github.io/abc-shop/`. Leave it empty and it uses whatever address the customer opened the shop from.
- **products**: one line per product. Give each one:
  - an `id`: short and unique, no spaces, e.g. `tee-black`
  - a `name`, `category` and `price`
  - `sizes`: use `["One size"]` for things without sizes
  - `art` and `color`: the drawing shown until the owner uploads a photo. Set `art` to `tee`, `hoodie`, `cap`, `tote`, `mug` or `sticker`, and `color` to its color. (You can also set `image` to a photo's web address, but it's easier to let the owner upload photos from `owner.html`.)
  - `memberPrice` (optional): a set price for members instead of the % off.
- **categories**: the filter buttons, in order.
- **shipping**: turn it on or off and set the flat fee.
- **rewards**: `punchValue` is the smallest order that earns a punch. Each order of that amount or more earns one punch, however big it is (after discounts, not counting shipping). Also set the punches needed and the reward name.
- **members**: turn it on or off, the starting % off and the perks list.
- **demo**: the drop and sales shown in practice mode only. Once the Worker is connected, the owner sets these from `owner.html`.

Prices live **only here**. The Worker reads this same block from the live page, so there is never a second price list to keep in sync.

## 2. Put it online
Upload `shop.html` and the `owner` folder (`owner/index.html`, `owner/manifest.webmanifest`, `owner/sw.js`) to the shop's website, GitHub Pages works fine. Rename `shop.html` to `index.html` if it should be the home page. Note the full address of the shop page, for example `https://yourname.github.io/abc-shop/`.

## 3. Create the Worker (free Cloudflare account)
1. **KV storage:** Storage & Databases → KV → Create. Name it `<shop>-shop`.
2. **Worker:** Workers & Pages → Create → Hello World. Name it `<shop>-shop` and click Deploy. Then click Edit code, replace everything with `shop-worker.js` (Ctrl+A, then Ctrl+V), and click Deploy.
3. **Connect the storage:** Worker → Settings → Bindings → Add → KV namespace. The variable name must be exactly `SHOP`. Pick the namespace you made.
4. **Settings:** Worker → Settings → Variables and Secrets → Add each of these. Names must match exactly.

   | Name | Type | Value |
   | --- | --- | --- |
   | `ADMIN_PASSWORD` | Secret | The owner's password |
   | `MARS_PASSWORD` | Secret | Mars's own password for `mars.html`. Keep it different from the owner's. |
   | `STRIPE_SECRET_KEY` | Secret | **Mars's** Stripe key, the same in every shop's Worker. `sk_test_...` while testing. |
   | `STRIPE_PUBLISHABLE_KEY` | Text or Secret | **Mars's** `pk_test_...`. It shows Stripe's sign-up form inside the owner app. |
   | `SITE_URL` | Text | The shop page address from step 2, exactly as customers open it |

   Optional, only to change the defaults: `PRO_PRICE` (Pro per month in dollars, 39 if not set), `FREE_FEE_PERCENT` (free-plan cut, 0.5 if not set), `PRO_FEE_PERCENT` (Pro cut, 0 if not set).
5. Copy the Worker address, e.g. `https://abc-shop.yourname.workers.dev`.

## 4. Connect the pages
Put the Worker address in all three pages, then upload them again:
- `shop.html`: `"api": "https://abc-shop.yourname.workers.dev"` in the settings block.
- `owner/index.html`: `const SHOP_API = 'https://abc-shop.yourname.workers.dev';` near the top of the script.
- `mars.html`: `const SHOP_API = 'https://abc-shop.yourname.workers.dev';` near the bottom.

If any of these is left empty, that page says the Shop API is empty.

## 5. Test the whole thing (test mode, no real money)
1. **Owner basics:** open the owner app (the `owner/` address, e.g. `https://yourname.github.io/abc-shop/owner/`) and sign in. Set a drop, put one item on sale, and save. Open the shop and check both show. Join as a member on the Members tab; prices drop.
2. **Activate:** open `mars.html` on the shop's site, type the Mars password, tap **Show this shop's plan**, fill in the owner's details and tap **Activate free tier**. From now until step 3 is done, checkout says card payments are being set up.
3. **Owner payment setup:** in the owner app, agree to the terms, then tap **Set up payments**. If Stripe offers to reuse an existing account, pick **Create a new account** (a real owner won't see that option). Stripe's test details:
   - Phone: Stripe's test number option; any code is `000000`
   - SSN `000-00-0000` · street address `address_full_match`
   - Bank: routing `110000000`, account `000123456789`
   - If the form shows **Radar Pro** (9¢ per screened payment), tap **Edit details** and turn it off. Basic fraud screening is free.

   Back in the owner app it shows "Stripe is checking your details" for a few minutes, then card payments switch on (tap **Check again**).
4. **Test order:** in the shop, check out with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC. You land on "Order placed" with a punch added.
5. **Check the money:**
   - In the **shop's** Stripe account (switch accounts at the top of the dashboard): the payment, minus fees, waiting to pay out to the shop's bank.
   - In **Mars's** account: Transactions → **Collected fees** shows the 0.5% (e.g. $0.27 on a $54.99 order).

## 6. Go live
Only when the test run above works:
1. In Mars's Stripe dashboard, switch off test mode and confirm Connect is set up in live mode too.
2. In the Worker, replace `STRIPE_SECRET_KEY` with `sk_live_...` and `STRIPE_PUBLISHABLE_KEY` with `pk_live_...`, and click Deploy.
3. The owner does **Set up payments** again for real. Test-mode Stripe accounts don't carry over to live mode.
4. Place one small real order and refund it to confirm.

## How prices work
The customer always pays the **single lowest price they qualify for**: the regular price, the sale price, this week's drop, or the member price. Deals don't stack. The Worker works out the price itself at checkout, so nobody can change what they pay. A member discount only applies if the email is really on the member list.

## Privacy policy
`privacy.html` is a plain-English privacy policy that fills in the shop's name, email, phone and address from `shop.html` by itself. It's linked from the app's Help tab, the join form and the cart.
- In `shop.html`, set `"privacy"`: `effective` to the date it takes effect (e.g. `"2026-11-01"`) and `host` to where the pages are hosted (e.g. `"GitHub Pages"`).
- It shows a **Template draft** notice until you set `"reviewed": true`. **Have a lawyer review it for the shop's state and business first.** It isn't legal advice.
- Upload `privacy.html` next to `shop.html`. If the shop page is renamed (e.g. to `index.html`), change `SHOP_PAGE` at the bottom of `privacy.html` to match.
- If the shop texts its members deals, have the lawyer check the texting rules too. They usually need clear permission from each person.

## Install on phones (QR code)
Customers scan the QR sign in the shop, the app opens, and after a couple of seconds an **"Add Shop to your phone"** banner slides up. Android shows a one-tap **Install app** button; iPhone shows the Share → Add to Home Screen steps (Apple doesn't allow an install button). Once installed, the shop icon sits on their home screen and opens full-screen like a normal app. No app store.

These files make that work. Upload them **all to the main folder** of the site, next to `shop.html` (not in a subfolder):
- `manifest.webmanifest`: the app's name ("Shop"), colors and icons. Its `scope` is `./shop.html` on purpose, so the shop app doesn't swallow the owner app; keep it that way (use `./index.html` if you renamed the shop page). Change `name`/`short_name` for a real shop (keep `short_name` 12 characters or less).
- `sw.js`: tells Android the site is an app. It caches nothing, so customers always see current prices and deals. Don't edit it.
- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`: the home-screen icon. For a real shop, replace them with its logo at the same sizes.
- `owner-icon-192.png`, `owner-icon-512.png`, `owner-icon-maskable-512.png`, `owner-apple-touch-icon.png` (main folder) plus the `owner` folder's `manifest.webmanifest` and `sw.js`: the owner's own home-screen app, **Shop Owner**, with a gold key icon. It lives in its own folder so phones treat it as a separate app from the shop. To install it, open the `owner/` address in Safari (iPhone: Share → Add to Home Screen) or Chrome (Android: ⋮ → Install app). For a real shop, change `name` in `owner/manifest.webmanifest` and `apple-mobile-web-app-title` in `owner/index.html` to the shop's name plus "Owner". The old `owner.html` just forwards to `owner/`.
- `qr-sign.pdf` (print this), `qr-sign.png`, `qr-code.png`: the QR code points to `https://celyum909-cyber.github.io/shop-demo/`. Make a new one if the address changes; a printed code can't be edited.

The banner is built into `shop.html`. Tapping X hides it for 3 days, and the Help tab has a **Show me how on this phone** button that brings it back any time.

**Test:** wait a couple of minutes after uploading, then scan the QR with an Android phone in Chrome. Tap **Install app** and check the icon on the home screen. On iPhone, use Safari.

## The free plan, Pro, and card payments

**The free plan** costs the shop nothing. Every card order carries a 0.5% cut that comes to Mars automatically (Stripe's application fee), on top of Stripe's own card fee. **Pro** is $39 a month and removes that cut. The owner upgrades and cancels from inside the owner app. Customer payments always go to the shop's own Stripe account (Stripe Connect), never through Mars.

**One-time setup on Mars's side (once, not per shop):** in Mars's Stripe dashboard, switch on **Connect** (Settings → Connect → Get started). Answer Stripe's questions about the platform and add its name, colour and icon, since Stripe shows them on the sign-up form. Each shop gets its own full Stripe account and pays Stripe's card fees itself, so Mars pays no Connect fees.

**At hand-over** (after step 5 has been run in test mode):
1. Activate the shop on `mars.html` (step 5.2).
2. The owner agrees to the terms and taps **Set up payments** (step 5.3). Until it's done, customers see "card payments are being set up" at checkout.
3. Make the two QR codes: the **customer** one points at the shop's address and goes on the counter sign; the **owner** one points at the same address plus `/owner/` and is texted to the owner privately, never printed.
4. If the owner wants Pro, they tap **Upgrade to Pro** in the owner app and pay by card. It renews monthly until they cancel.

**Paid for Pro in cash?** On `mars.html`, tick Pro and set the **Pro paid through** date by hand.

**Refunds and chargebacks:** the shop refunds from its own Stripe account. The 0.5% cut isn't returned on refunds or chargebacks, and it's never added to the customer's bill as a surcharge. `terms.html` says so.

**Shops never activated** on `mars.html` work as before: checkout uses Mars's key directly, with no connected account and no cut. Activate every real shop.

- `terms.html`: the service terms, the Pro terms and the privacy notice for shop owners. The provider details are filled in at the bottom. Have a lawyer review it, then set `reviewed: true` to remove the Draft notice.
- `mars.html`: Mars's private page for activating a shop and setting Pro by hand. Don't link to it from the shop.

## Owner tips
- **Weekly drop:** pick a product, a price below regular, and an end date. It disappears on its own after that date. "Members only" means everyone sees it but only members get the price, which is a good reason to join.
- **Sales:** type a sale price next to any item. Leave the box empty for no sale.
- **Photos:** tap **Add photo** next to a product and pick one from the phone or take one. It's shrunk to about 1200 pixels automatically, so uploads are quick. Each product gets one photo, and a new one replaces the old. JPG, PNG or WebP only, 2 MB max after shrinking. Square photos look best.
- **Members:** see who joined, change the % off, and download the list as a spreadsheet for emails or texts. Tap **Remove** (then **Sure?**) to delete someone who asks, as the privacy policy promises.
- **Rewards:** when a card is full, the customer shows the Rewards screen and staff tap "Staff: mark as claimed" twice.
- **Order emails:** in Stripe, turn on Settings → Business → Customer emails → Successful payments. That emails customers their receipts. Every order also appears in Stripe → Payments, marked PICKUP IN STORE or SHIP.
- **Change the password:** Cloudflare → the Worker → Settings → edit `ADMIN_PASSWORD`. The owner app will ask them to sign in again.

## Good to know
- If checkout shows an error about **Managed Payments** or **tax codes**: that Stripe setting is for digital products. The Worker already turns it off for each checkout, so make sure you're running the latest `shop-worker.js`.
- Photos are stored in the same Cloudflare storage as everything else, so there's nothing extra to set up. A shop with 20 products uses about 5 MB. Cloudflare's free plan allows 1 GB of storage, 1,000 saves and 100,000 reads a day per account. Photos are kept in Cloudflare's cache after the first view, so customers looking at them barely touches the read limit.
- The rewards card and membership are remembered on the customer's phone. The member list itself is saved in the Worker, so members who switch phones can just join again with the same email.
- Sales tax isn't calculated yet. Stripe Tax can be turned on later.
- Stock levels aren't tracked. Every size always shows as available.
- Product prices update in checkout within about a minute of uploading a new `shop.html`.
