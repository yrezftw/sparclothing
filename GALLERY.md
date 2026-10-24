# spår gallery: what it is and how to switch it on

## What you get
Scanning a garment's QR code opens **sparclothing.se/g/{ID}** in the phone's browser. No App Store, works on iPhone and Android.

- **First scan by the buyer:** "This garment is waiting for its owner". They type the code from the inside label and the gallery is theirs on that phone.
- **Owner:** adds photos straight from the phone's photo library, names the gallery, picks *Only me* or *Anyone who scans*, approves or declines photos friends send, saves photos back to the phone, and can "hand it on" when the garment is sold (deletes all photos; the next owner claims a fresh gallery with the same label code).
- **Find my photos:** the owner selects a batch of photos from the camera roll (on iPhone you can swipe across many at once). The app reads the QR code in each photo on the phone itself and puts every photo that shows one of their garments into that garment's gallery. Photos without a code never leave the phone, and a photo picked twice is only added once. From the home screen it sorts into all their garments at once.
- **Friends who scan it:** can send a photo of the wearer. It waits for the owner's approval. If the gallery is public they also see the approved photos.
- **App on the home screen:** "Add to Home Screen" (iPhone, from Safari's Share menu) or "Install app" (Android) puts a spår icon on the phone. It opens a list of your garments, and photos you've looked at still show without signal.
- **Privacy built in:** galleries start private, location data (GPS/EXIF) is removed from every photo, photos are stored in the EU, and private photos can't be opened by anyone without the owner's sign-in.
- **Admin page** at **sparclothing.se/g/admin**: you load the register CSV from the QR generator there, so every printed code works.

What a web app can't do: read the camera roll on its own. Apple and Google only let a website see the photos the person selects, and it can copy them but not delete them from the phone. Fully automatic sorting (open the app and it has already found every new photo with the shirt in it) and moving photos out of the phone's gallery need a native App Store / Google Play app.

How well codes are found (tested 2026-10-24 with codes from the updated QR generator, logo in the middle, black on a bone tee and white on a black tee): every logo size read as well as codes without a logo. Sharp photos were read down to a code about 2% of the photo's width; slightly blurry photos at an angle needed about 4–5%. In a full-body photo a code printed 10 cm wide is about 5% of the width. Real fabric folds and motion blur will miss more, so test with printed shirts before promising it to customers.

**Photo test page:** https://claude.ai/artifact/THuWnkjCcKWAhFGPG9ba45 runs the same reader on your phone without the gallery being live: pick photos of a printed test shirt and it shows which ones the code was found in and how big the code was. Nothing is uploaded. Source: `tools/photo-test.src.html` (build with `tools/build-photo-test.py`).

Why a web app and not an App Store app: a QR scan opens a web link anyway, so a native app would add a "go install this first" step, 99 USD/year for Apple, review delays and two codebases, with nothing extra the gallery needs. If you later want camera-roll scanning (finding your garment in photos automatically), that's the point where a native app pays off, and the same codes keep working.

## Cost
Free at the start on Cloudflare's free plan: 10 GB of photos (about 20,000 photos) in R2, the database in D1, and 100,000 requests a day (every page, file or photo loaded counts as one). After 10 GB it's about 0.15 kr per GB per month. R2 asks for a payment card when you switch it on, even on the free tier. If the site ever needs more than 100,000 requests a day, Cloudflare's Workers Paid plan is 5 USD a month for 10 million.

## Go live (do this before printing)
Your codes already point at their final address, `https://sparclothing.se/g/{ID}`, the app is built and the domain is yours. What's missing is putting it online, which needs accounts in your name. The shop's checkout, the enskild firma and Stripe aren't needed for the gallery; they can follow later (GO-LIVE.md steps 1, 5 and 6).

1. **Domain:** done. sparclothing.se and spårclothing.se were bought at Loopia on 24 October 2026.
2. **GitHub:** make a free account at github.com and an empty repository called `sparclothing`, then connect GitHub to Claude at https://claude.ai/connect-github.
3. **Cloudflare account:** make a free account at dash.cloudflare.com. Choose **Add a domain**, type `sparclothing.se` and pick the **Free** plan. Cloudflare then shows you two nameservers. In Loopia's Customer Zone, click the domain and first switch off **DNSSEC** if it's on (Loopia switches it on for .se domains, and if it stays on after the move, the site won't open for many visitors). Then press **Name servers** and enter the two from Cloudflare. Do the same for `spårclothing.se`; if Cloudflare won't take the å, type `xn--sprclothing-y8a.se`, which is the same name. The switch can take a few hours.
4. **Database:** in Cloudflare go to **Storage & Databases → D1 → Create**. Name it `spar-gallery`, location *Western Europe*. Copy the **Database ID** and send it to Claude (it isn't a secret).
5. **Photo storage:** **R2 → Overview** → add a payment card if asked (the free tier still needs one) → **Create bucket**. Name it `spar-gallery-photos`, and under *Location* pick **Specify jurisdiction → European Union**.
6. Claude puts the shop and the gallery in your GitHub repository. Wait for Claude's message.
7. **Website:** **Workers & Pages → Create → Pages → Connect to Git**, pick `sparclothing`, press **Save and Deploy**. Then in the new project:
   - **Settings → Variables and Secrets → Add**: type **Secret**, name `ADMIN_TOKEN`, value a long password only you know. Never paste it in chat.
   - **Custom domains → Set up a domain**: add `sparclothing.se`, then the same way `www.sparclothing.se`, `spårclothing.se` and `www.spårclothing.se`. The last three forward to sparclothing.se by themselves. If Cloudflare says a DNS record for one of the names already exists, delete that record under the domain's **DNS → Records** and try again.
   - **Deployments**: press **Retry deployment** on the latest one, so it picks up the password.
8. **Load your codes:** open **sparclothing.se/g/admin**, enter the admin password, pick the register CSV file(s) from the QR generator and press **Load register**. Do this after every new batch of codes; loading the same file twice is safe.
9. **Test:** scan one of your codes (on screen or printed), claim it with its label code and add a photo. Then print.

Until Stripe is set up, the shop page is visible but its checkout says it isn't open yet.

## Files
- `public/g/` the app (page, script, styles, icons, offline support). QR readers: `zxing-reader.js` + `zxing_reader.wasm` (zxing-cpp, fast, loaded only when finding photos) with `jsqr.min.js` as backup; licences in `THIRD-PARTY-LICENSES.txt`
- `functions/g/[[path]].js` makes every /g/{ID} address open the app
- `functions/_middleware.js` forwards www.sparclothing.se, spårclothing.se and www.spårclothing.se to sparclothing.se
- `functions/api/g/[[path]].js` + `lib/gallery-api.js` the server: claim, photos, approval, admin import
- `test/` browser tests (`e2e.js`, `e2e-find.js`) and `make-test-photos.js` for fake photos with codes in them
- `wrangler.toml` for trying the gallery on its own (`npx wrangler pages dev public --binding ADMIN_TOKEN=test`)
- `STORE-CHANGES.md` how it slots into the shop site; `tools/assemble-site.py` builds the combined shop + gallery folder for the repository (`python3 tools/assemble-site.py <new folder> --d1-id <Database ID>`)
