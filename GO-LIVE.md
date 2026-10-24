# Putting spårclothing online

The site is finished on the code side: shop, cart, Stripe checkout (card, Klarna, Swish), order confirmation, terms and privacy pages. What's left are accounts that have to be in your name. Total fixed cost: about 150–250 kr a year for the domain. Hosting is free and Stripe takes a fee per sale.

## 1. Register the business (if you haven't)
Selling clothes regularly counts as running a business in Sweden. Register an **enskild firma** at [verksamt.se](https://www.verksamt.se) and apply for F-skatt and VAT (moms) registration. It's free and is usually done in a couple of weeks. Stripe needs your org.nr (personnummer for an enskild firma) and a bank account.

## 2. Buy the domain
Buy **sparclothing.se** (and spårclothing.se if you want it) from a Swedish registrar such as Loopia, Binero or One.com. Use the plain `sparclothing.se` in the QR codes.

## 3. Put the code on GitHub
1. Create a free account at [github.com](https://github.com) and an empty repository called `sparclothing`.
2. Connect GitHub to Claude: https://claude.ai/connect-github
3. Tell Claude in the project thread. Claude pushes this folder to the repository.

## 4. Host it on Cloudflare Pages (free)
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create → Pages → Connect to Git**, pick the `sparclothing` repository and press **Save and Deploy**. No build command is needed; the settings are in `wrangler.toml`.
3. Under **Settings → Variables and Secrets**, add `STRIPE_SECRET_KEY` as a **Secret** (see step 5).
4. Under **Custom domains**, add `sparclothing.se` and follow the instructions to point the domain at Cloudflare.

Every later change Claude pushes to GitHub goes live automatically.

## 5. Stripe
1. Create an account at [stripe.com](https://stripe.com) and fill in your business details.
2. Under **Settings → Payment methods**, turn on **Klarna** and **Swish** (cards are on by default).
3. Under **Developers → API keys**, copy the **secret key**. Start with the test key (`sk_test_…`) and buy something with the test card `4242 4242 4242 4242`. When that works, replace it with the live key (`sk_live_…`). Never paste the secret key in chat.
4. Under **Settings → Emails**, turn on receipts for successful payments.

Orders show up in the Stripe dashboard under **Payments**, with size, address and phone number.

## 6. Fill in your details
Before launch, replace these:
- `public/products.json`: your real products, colours, sizes and prices (whole kronor, VAT included). The checkout reads prices from here, so a customer can't change them.
- `public/villkor.html` and `public/integritet.html`: company name, org.nr, address and email (marked in dashed boxes).
- Product photos, when you have them.

## 7. Switch on the garment gallery
Once the shop is live, follow the gallery guide ([gallery/SETUP.md](/mnt/project-files/gallery/SETUP.md)) to create the photo database and photo storage in Cloudflare and set an admin password. Photo storage (R2) asks for a payment card even on the free plan. Then send Claude the D1 **Database ID** (it isn't a secret), and Claude adds the gallery to the site at sparclothing.se/g/.

## Good to know
- **VAT to other EU countries:** Swedish 25% VAT applies until your sales to other EU countries pass €10,000 a year. After that you register for OSS with Skatteverket and charge each country's VAT. Stripe Tax can do this automatically.
- **Shipping** in checkout: Sweden 59 kr (free from 800 kr), rest of the EU 99 kr. Norway is left out because it's outside the EU and needs separate VAT registration. Change the rules in `functions/api/checkout.js`.
- **Stock:** there's no stock tracking yet. If something sells out, remove the size from `products.json`.

## Files
- `public/` the website (shop, confirmation, terms, privacy)
- `functions/api/checkout.js` creates the Stripe checkout with server-side prices
- `wrangler.toml` Cloudflare Pages settings

To run it locally: `npx wrangler pages dev public --binding STRIPE_SECRET_KEY=sk_test_…`
