# Shop template: setting up a new shop

Three files make one shop:

| File | Who uses it | What it is |
| --- | --- | --- |
| `shop.html` | Customers | The phone app: shop, weekly drop, sales, cart, checkout, rewards card, members |
| `owner.html` | The shop owner | Sign in to set the weekly drop, sale prices and member discount, and see members |
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
Upload `shop.html` and `owner.html` to the shop's website, GitHub Pages works fine. Rename `shop.html` to `index.html` if it should be the home page. Note the full address of the shop page, for example `https://yourname.github.io/abc-shop/`.

## 3. Create the Worker (free Cloudflare account)
1. **KV storage:** Storage & Databases → KV → Create. Name it `<shop>-shop`.
2. **Worker:** Workers & Pages → Create → Hello World. Name it `<shop>-shop` and click Deploy. Then click Edit code, replace everything with `shop-worker.js`, and click Deploy.
3. **Connect the storage:** Worker → Settings → Bindings → Add → KV namespace. The variable name must be exactly `SHOP`. Pick the namespace you made.
4. **Settings:** Worker → Settings → Variables and Secrets → Add each of these:
   - `ADMIN_PASSWORD`, type **Secret**: the owner's password
   - `STRIPE_SECRET_KEY`, type **Secret**: the shop's Stripe key (`sk_test_...` first)
   - `SITE_URL`, type **Text**: the shop page address from step 2, exactly as customers open it
5. Copy the Worker address, e.g. `https://abc-shop.yourname.workers.dev`.

## 4. Connect the pages
- In `shop.html`, set `"api": "https://abc-shop.yourname.workers.dev"` in the settings block.
- In `owner.html`, set `const SHOP_API = 'https://abc-shop.yourname.workers.dev';` near the top of the script.

Upload both again.

## 5. Test
1. Open `owner.html` and sign in. Set a drop, put one item on sale, and save.
2. Open the shop. The drop and the sale should be showing.
3. Join as a member on the Members tab. Prices drop.
4. Check out with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC. You land back on "Order placed" with punches added, and the order shows in Stripe → Payments (test mode).
5. Swap in the `sk_live_...` key when ready.

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
- `manifest.webmanifest`: the app's name ("Shop"), colors and icons. Change `name`/`short_name` for a real shop (keep `short_name` 12 characters or less).
- `sw.js`: tells Android the site is an app. It caches nothing, so customers always see current prices and deals. Don't edit it.
- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`: the home-screen icon. For a real shop, replace them with its logo at the same sizes.
- `owner.webmanifest`, `owner-icon-192.png`, `owner-icon-512.png`, `owner-icon-maskable-512.png`, `owner-apple-touch-icon.png`: the same for `owner.html`, so the owner can add their owner page to the home screen as its own **Shop Owner** app with a gold key icon (iPhone: Safari → Share → Add to Home Screen; Android: Chrome → Install app). For a real shop, change `name` in `owner.webmanifest` and `apple-mobile-web-app-title` in `owner.html` to the shop's name plus "Owner".
- `qr-sign.pdf` (print this), `qr-sign.png`, `qr-code.png`: the QR code points to `https://celyum909-cyber.github.io/shop-demo/`. Make a new one if the address changes; a printed code can't be edited.

The banner is built into `shop.html`. Tapping X hides it for 3 days, and the Help tab has a **Show me how on this phone** button that brings it back any time.

**Test:** wait a couple of minutes after uploading, then scan the QR with an Android phone in Chrome. Tap **Install app** and check the icon on the home screen. On iPhone, use Safari.

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
