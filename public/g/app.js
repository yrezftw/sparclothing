// spår gallery app. One page, three screens picked from the address:
//   /g/          your garments on this phone (the home-screen app opens here)
//   /g/{ID}      one garment: claim it, see its photos, add photos
//   /g/admin     Rasmus: load the QR register CSV
"use strict";

const ID_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const FULL_EDGE = 2048, THUMB_EDGE = 600;
const app = document.getElementById("app");

// ---------- small helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const $ = sel => document.querySelector(sel);

async function api(path, { method = "GET", json, body } = {}) {
  const headers = { "x-spar": "1" };
  if (json !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`/api/g/${path}`, {
      method, headers, credentials: "same-origin",
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
    throw Object.assign(new Error("No connection. Check your internet and try again."), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem("spar.garments") || "[]"); } catch { return []; } },
  set(list) { try { localStorage.setItem("spar.garments", JSON.stringify(list)); } catch {} },
  remember(g) {
    const list = this.get().filter(x => x.id !== g.id);
    list.unshift({ ...g, seen: Date.now() });
    this.set(list.slice(0, 30));
  },
  forget(id) { this.set(this.get().filter(x => x.id !== id)); },
};

const photoUrl = (id, pid, size) => `/api/g/${id}/photos/${pid}/${size}`;
const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const garmentName = g => g.title || g.product || "spår garment";

// Android/desktop Chrome offer a real install button; iPhone needs the Share menu.
let installEvent = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; document.dispatchEvent(new Event("installable")); });

function installCard() {
  if (standalone) return null;
  const card = h("div", { class: "card", hidden: !isIos && !installEvent },
    h("h2", null, "Keep it on your home screen"),
    isIos
      ? h("p", { class: "muted small" }, "In Safari, tap the Share button, then ", h("b", null, "Add to Home Screen"),
          ". Your garments open like an app, no App Store needed.")
      : [h("p", { class: "muted small" }, "Install the spår gallery so your garments open like an app."),
         h("button", { class: "btn primary", onclick: async () => { installEvent?.prompt(); installEvent = null; card.hidden = true; } }, "Install app")]);
  document.addEventListener("installable", () => (card.hidden = false));
  return card;
}

// ---------- photos: shrink and clean before upload ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name || "That file"} isn't a photo we can read`)); };
    img.src = url;
  });
}

function toJpeg(img, edge, quality) {
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return new Promise(res => canvas.toBlob(b => res({ blob: b, w, h }), "image/jpeg", quality));
}

// Re-drawing the photo on a canvas drops its EXIF data, including GPS position.
async function preparePhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const full = await toJpeg(img, FULL_EDGE, 0.85);
    const thumb = await toJpeg(img, THUMB_EDGE, 0.8);
    return { full, thumb };
  } finally { URL.revokeObjectURL(url); }
}

async function fingerprint(file) {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function uploadPhotos(id, files, extra, onProgress) {
  let done = 0, failed = 0, dupes = 0, lastError = "";
  for (const file of files) {
    try {
      const { full, thumb } = await preparePhoto(file);
      const fd = new FormData();
      fd.append("hash", await fingerprint(file));
      fd.append("full", full.blob, "full.jpg");
      fd.append("thumb", thumb.blob, "thumb.jpg");
      fd.append("w", full.w);
      fd.append("h", full.h);
      for (const [k, v] of Object.entries(extra || {})) fd.append(k, v);
      const r = await api(`${id}/photos`, { method: "POST", body: fd });
      r.duplicate ? dupes++ : done++;
    } catch (e) { failed++; lastError = e.message; }
    onProgress?.((done + failed + dupes) / files.length);
  }
  return { done, failed, dupes, lastError };
}

function pickPhotos(multiple = true) {
  return new Promise(resolve => {
    const input = h("input", { type: "file", accept: "image/*", multiple, hidden: true });
    input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
    input.addEventListener("cancel", () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// ---------- dialogs ----------

function sheet(...children) {
  const d = h("dialog", { class: "sheet" }, ...children);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", e => { if (e.target === d) d.close(); }); // tap outside
  document.body.append(d);
  d.showModal();
  return d;
}

function viewer(id, photos, start, { owner, onDelete } = {}) {
  let i = start;
  const img = h("img", { alt: "" });
  const counter = h("span", { class: "counter" });
  const byline = h("span", { class: "small" });
  const d = h("dialog", { class: "viewer", "aria-label": "Photo" },
    h("div", { class: "stage" }, img),
    h("div", { class: "bar top" }, counter, h("button", { class: "btn", onclick: () => d.close() }, "Close")),
    h("button", { class: "nav prev", "aria-label": "Previous photo", onclick: () => go(-1) }, "‹"),
    h("button", { class: "nav next", "aria-label": "Next photo", onclick: () => go(1) }, "›"),
    h("div", { class: "bar bottom" }, byline, h("div", { class: "row" },
      h("button", { class: "btn", onclick: save }, "Save"),
      owner && h("button", { class: "btn danger", onclick: del }, "Delete"))));
  function show() {
    const p = photos[i];
    img.src = photoUrl(id, p.id, "full");
    counter.textContent = `${i + 1} / ${photos.length}`;
    byline.textContent = p.name ? `Photo by ${p.name}` : new Date(p.created * 1000).toLocaleDateString();
  }
  function go(step) { if (photos.length) { i = (i + step + photos.length) % photos.length; show(); } }
  async function save() {
    const p = photos[i];
    const res = await fetch(photoUrl(id, p.id, "full"));
    const blob = await res.blob();
    const file = new File([blob], `spar-${id}-${p.id}.jpg`, { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch {}
    } else {
      const a = h("a", { href: URL.createObjectURL(blob), download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  }
  async function del() {
    if (!confirm("Delete this photo for good?")) return;
    try {
      await api(`${id}/photos/${photos[i].id}`, { method: "DELETE" });
      onDelete?.(photos[i].id);
      photos.splice(i, 1);
      if (!photos.length) return d.close();
      i = Math.min(i, photos.length - 1);
      show();
    } catch (e) { toast(e.message); }
  }
  let x0 = null;
  d.addEventListener("touchstart", e => (x0 = e.touches[0].clientX), { passive: true });
  d.addEventListener("touchend", e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    x0 = null;
  });
  d.addEventListener("keydown", e => { if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  show();
}

function photoGrid(id, photos, opts) {
  return h("div", { class: "grid" }, photos.map((p, i) =>
    h("button", { "aria-label": `Open photo ${i + 1}`, onclick: () => viewer(id, photos, i, opts) },
      h("img", { src: photoUrl(id, p.id, "thumb"), alt: "", loading: "lazy" }))));
}

// ---------- screen: one garment ----------

async function garmentScreen(id) {
  let g;
  try { g = await api(id); }
  catch (e) {
    if (e.status === 404) {
      store.forget(id);
      return render(h("div", { class: "hero" }, h("span", { class: "tag" }, id),
        h("h1", null, "We can't find this garment"),
        h("p", null, e.message), h("p", null, h("a", { href: "/g/" }, "Go to your garments"))));
    }
    return render(h("div", { class: "hero" }, h("h1", null, "Couldn't open the gallery"), h("p", null, e.message),
      h("p", null, h("button", { class: "btn", onclick: () => garmentScreen(id) }, "Try again"))));
  }
  document.title = `${garmentName(g)} · spår`;
  if (g.claimed && g.owner) {
    store.remember({ id, title: g.title, product: g.product, owner: true, thumb: g.photos[0]?.id || null });
    return ownerView(g);
  }
  if (!g.claimed) return unclaimedView(g);
  store.remember({ id, title: g.title, product: g.product, owner: false, thumb: g.visibility === "public" ? g.photos[0]?.id || null : null });
  return visitorView(g);
}

function claimForm(g, { compact } = {}) {
  const input = h("input", { type: "text", class: "code", name: "code", inputmode: "text", autocomplete: "off",
    autocapitalize: "characters", spellcheck: "false", placeholder: "XXXX-XXXX", maxlength: 12, "aria-label": "Claim code" });
  const err = h("p", { class: "error", hidden: true });
  const btn = h("button", { class: "btn primary block", type: "submit" }, compact ? "Unlock" : "Claim my garment");
  const form = h("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      await api(`${g.id}/claim`, { method: "POST", json: { code: input.value } });
      toast(g.claimed ? "Welcome back" : "It's yours. Add your first photos.");
      garmentScreen(g.id);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } }, h("label", { class: "field" }, h("span", { class: "label" }, "Code on the inside label"), input), err, btn);
  return form;
}

function unclaimedView(g) {
  render(
    h("div", { class: "hero" }, h("span", { class: "tag" }, g.id),
      h("h1", null, "This garment is waiting for its owner"),
      h("p", null, "Every spår garment has its own photo gallery. The owner unlocks it once with the code on the inside label.")),
    h("div", { class: "card" }, h("h2", null, "Is it yours?"), claimForm(g)),
    h("p", { class: "muted small" }, "Not yours? Once the owner has set it up, you can scan this code again to add photos of them wearing it."));
}

function visitorView(g) {
  const name = garmentName(g);
  const canSee = g.visibility === "public";
  render(
    h("div", { class: "hero" }, h("span", { class: "tag" }, g.id), h("h1", null, name),
      h("p", null, canSee ? `${g.photos.length} photo${g.photos.length === 1 ? "" : "s"} of this garment.` : "The owner keeps this gallery private.")),
    canSee && (g.photos.length ? photoGrid(g.id, g.photos) : h("div", { class: "empty" }, "No photos yet.")),
    g.guestUploads && h("div", { class: "card" },
      h("h2", null, "Took a photo of them in it?"),
      h("p", { class: "muted small" }, "Send it to this garment's gallery. The owner sees it first and decides if it stays."),
      h("button", { class: "btn primary", onclick: () => guestUploadSheet(g) }, "Add a photo")),
    h("p", { class: "small" }, h("button", { class: "linkbtn", onclick: () => sheet(h("h2", null, "Unlock your gallery"), claimForm(g, { compact: true })) },
      "This is my garment")));
}

function guestUploadSheet(g) {
  const nameInput = h("input", { type: "text", name: "name", maxlength: 40, autocomplete: "name", placeholder: "Optional" });
  const consent = h("input", { type: "checkbox", name: "consent" });
  const err = h("p", { class: "error", hidden: true });
  const bar = h("span");
  const progress = h("div", { class: "progress", hidden: true }, bar);
  const btn = h("button", { class: "btn primary block", type: "submit" }, "Choose photos");
  const d = sheet(h("h2", null, "Add a photo"), h("form", { onsubmit: async e => {
    e.preventDefault();
    err.hidden = true;
    if (!consent.checked) { err.textContent = "Tick the box first."; err.hidden = false; return; }
    const files = await pickPhotos();
    if (!files.length) return;
    btn.disabled = true; progress.hidden = false;
    const r = await uploadPhotos(g.id, files, { consent: "yes", name: nameInput.value }, f => (bar.style.width = `${f * 100}%`));
    if (r.done) { d.close(); toast(`Sent ${r.done} photo${r.done === 1 ? "" : "s"}. The owner will see ${r.done === 1 ? "it" : "them"} soon.`); }
    else { err.textContent = r.lastError; err.hidden = false; btn.disabled = false; progress.hidden = true; }
  } },
    h("label", { class: "field" }, h("span", { class: "label" }, "Your name"), nameInput),
    h("label", { class: "check" }, consent,
      h("span", null, "I took this photo or may share it, and the people in it are fine with it being in this gallery.")),
    h("p", { class: "muted small" }, "We remove location data from photos. ", h("a", { href: "/integritet", target: "_blank" }, "Privacy")),
    err, progress, btn));
}

function ownerView(g) {
  const name = garmentName(g);
  const addBtn = h("button", { class: "btn primary fab", onclick: () => addChoiceSheet(g) }, "+ Add photos");
  render(
    h("div", { class: "hero" },
      h("div", { class: "spread" }, h("span", { class: "tag" }, g.id),
        h("button", { class: "btn", onclick: () => settingsSheet(g) }, "Settings")),
      h("h1", null, name),
      h("p", null, `${g.photos.length} photo${g.photos.length === 1 ? "" : "s"} · `,
        g.visibility === "public" ? "anyone who scans can see them" : "only you can see them")),
    g.pending.length > 0 && h("div", { class: "card" },
      h("h2", null, `${g.pending.length} new from others`),
      h("p", { class: "muted small" }, "Approve to add to your gallery, or decline to delete."),
      h("div", { class: "pending" }, g.pending.map(p => pendingItem(g, p)))),
    g.photos.length
      ? photoGrid(g.id, g.photos, { owner: true, onDelete: () => garmentScreen(g.id) })
      : h("div", { class: "empty" }, "No photos yet. Add the first ones, or let friends scan the code and send theirs."),
    installCard(),
    addBtn);
}

function pendingItem(g, p) {
  const act = async method => {
    try {
      await api(`${g.id}/photos/${p.id}`, { method });
      garmentScreen(g.id);
    } catch (e) { toast(e.message); }
  };
  return h("div", { class: "item" },
    h("button", { style: "border:0;padding:0;background:none", "aria-label": "View photo", onclick: () => viewer(g.id, [p], 0) },
      h("img", { src: photoUrl(g.id, p.id, "thumb"), alt: "" })),
    h("div", { class: "stack" },
      h("div", { class: "small" }, p.name ? `From ${p.name}` : "From someone who scanned your code"),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: () => act("PATCH") }, "Approve"),
        h("button", { class: "btn", onclick: () => act("DELETE") }, "Decline"))));
}

function addChoiceSheet(g) {
  const d = sheet(h("h2", null, "Add photos"), h("div", { class: "stack" },
    h("p", { class: "muted small" }, "Select a whole batch from your camera roll. The app reads the QR code in each photo on your phone and keeps only the ones showing this garment. The rest never leave your phone."),
    h("button", { class: "btn primary block", onclick: () => { d.close(); findPhotos({ [g.id]: garmentName(g) }); } }, "Find photos with this garment"),
    h("button", { class: "btn block", onclick: () => { d.close(); ownerUpload(g); } }, "Pick photos myself")));
}

async function ownerUpload(g) {
  const files = await pickPhotos();
  if (!files.length) return;
  const bar = h("span");
  const d = sheet(h("h2", null, `Adding ${files.length} photo${files.length === 1 ? "" : "s"}…`), h("div", { class: "progress" }, bar));
  d.addEventListener("cancel", e => e.preventDefault());
  const r = await uploadPhotos(g.id, files, null, f => (bar.style.width = `${f * 100}%`));
  d.close();
  toast(r.failed ? `${r.done} added, ${r.failed} failed: ${r.lastError}` : `${r.done} added${r.dupes ? `, ${r.dupes} were already there` : ""}`);
  garmentScreen(g.id);
}

function settingsSheet(g) {
  const title = h("input", { type: "text", name: "title", maxlength: 60, value: g.title || "", placeholder: g.product || "My spår garment" });
  const vis = v => h("label", null, h("input", { type: "radio", name: "visibility", value: v, checked: g.visibility === v }),
    v === "private" ? "Only me" : "Anyone who scans");
  const guests = h("input", { type: "checkbox", name: "guests", checked: g.guestUploads });
  const err = h("p", { class: "error", hidden: true });
  const d = sheet(h("h2", null, "Gallery settings"), h("form", { onsubmit: async e => {
    e.preventDefault();
    try {
      await api(g.id, { method: "PATCH", json: {
        title: title.value,
        visibility: d.querySelector("input[name=visibility]:checked").value,
        guestUploads: guests.checked,
      } });
      d.close();
      toast("Saved");
      garmentScreen(g.id);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } },
    h("label", { class: "field" }, h("span", { class: "label" }, "Name"), title),
    h("div", { class: "field" }, h("span", { class: "label" }, "Who can see the photos"), h("div", { class: "seg" }, vis("private"), vis("public"))),
    h("label", { class: "check" }, guests, h("span", null, "Let people who scan the code send me photos. I approve each one first.")),
    err,
    h("button", { class: "btn primary block", type: "submit" }, "Save"),
    h("hr"),
    h("button", { class: "btn block", type: "button", onclick: async () => {
      await api(`${g.id}/logout`, { method: "POST" }).catch(() => {});
      await clearCached(g.id);
      store.forget(g.id);
      location.href = "/g/";
    } }, "Sign out on this phone"),
    h("button", { class: "btn danger block", type: "button", onclick: () => releaseSheet(g, d) }, "Sold or gave it away?")));
}

function releaseSheet(g, parent) {
  parent.close();
  const d = sheet(h("h2", null, "Hand it on"), h("div", { class: "stack" },
    h("p", null, "This deletes all ", h("b", null, `${g.photos.length + g.pending.length} photos`),
      " for good and signs you out. The next owner unlocks a fresh, empty gallery with the same code on the label."),
    h("p", { class: "muted small" }, "Save any photos you want to keep first (open a photo, then Save)."),
    h("button", { class: "btn danger block", onclick: async () => {
      try {
        await api(`${g.id}/release`, { method: "POST" });
        await clearCached(g.id);
        store.forget(g.id);
        d.close();
        location.href = "/g/";
      } catch (e) { toast(e.message); }
    } }, "Delete everything and release"),
    h("button", { class: "btn block", onclick: () => d.close() }, "Cancel")));
}

async function clearCached(id) {
  navigator.serviceWorker?.controller?.postMessage({ type: "forget", id });
}

// ---------- finding garment QR codes inside photos (all on the phone) ----------

// The main reader is zxing-cpp compiled to WebAssembly: it finds small, tilted and
// white-on-black codes in full-size photos in a fraction of a second.
// If it can't load, a slower JavaScript reader (jsQR) reads the photo in overlapping pieces.
const ZX_OPTS = { formats: ["QRCode"], tryHarder: true, tryInvert: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 8 };
const MAX_CANVAS_PX = 16e6; // iPhone Safari refuses bigger canvases
let zxingReady, jsqrReady, detector;

function loadScript(src, ready) {
  return new Promise((resolve, reject) => {
    const s = h("script", { src });
    s.onload = () => resolve(ready());
    s.onerror = () => reject(new Error("Couldn't load the code reader. Check your connection."));
    document.head.append(s);
  });
}
function loadZXing() {
  zxingReady ??= loadScript("/g/zxing-reader.js", () => self.ZXingWASM)
    .then(async zx => {
      await zx.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? "/g/zxing_reader.wasm" : prefix + path) },
        fireImmediately: true,
      });
      return zx;
    })
    .catch(e => { zxingReady = null; throw e; });
  return zxingReady;
}
function loadJsQR() {
  jsqrReady ??= loadScript("/g/jsqr.min.js", () => self.jsQR).catch(e => { jsqrReady = null; throw e; });
  return jsqrReady;
}

const idFromQr = text => {
  const m = /\/g\/([23456789A-Z]{6})(?=[/?#]|$)/i.exec(String(text || "").trim());
  return m ? m[1].toUpperCase() : null;
};
const uniqueIds = texts => [...new Set(texts.map(idFromQr).filter(Boolean))];

async function toBitmap(file) {
  try { return await createImageBitmap(file); }
  catch {
    const { img, url } = await loadImage(file);
    try { return await createImageBitmap(img); } finally { URL.revokeObjectURL(url); }
  }
}

// Pixels of the photo, shrunk only if it's bigger than the phone allows for a canvas.
function pixelsOf(bmp, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, maxPx = MAX_CANVAS_PX) {
  const scale = Math.min(1, Math.sqrt(maxPx / (sw * sh)));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(sw * scale), height: Math.round(sh * scale) });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// The QR generator's files have a see-through background, which code readers take
// for black, so a black code on it can't be read. Pictures with see-through parts
// are read on white (dark codes) and then on black (light codes).
function onSolidBackground(px) {
  const d = px.data;
  let seeThrough = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { seeThrough = true; break; }
  if (!seeThrough) return [px];
  return [255, 0].map(bg => {
    const out = new ImageData(px.width, px.height), o = out.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255, under = bg * (1 - a);
      o[i] = d[i] * a + under; o[i + 1] = d[i + 1] * a + under; o[i + 2] = d[i + 2] * a + under; o[i + 3] = 255;
    }
    return out;
  });
}

// Returns the garment IDs whose QR codes can be read in this photo. Codes the reader found
// but couldn't read go in seen.misses, as corner points in the upright photo.
async function garmentIdsInPhoto(file, seen = {}) {
  const zx = await loadZXing().catch(() => null);
  if (!zx) return slowGarmentIds(file);
  // Near-misses are codes the reader found but couldn't read, as their corner points.
  // They count towards the reader's limit of codes per photo, so the limit is raised.
  const read = async img => {
    const found = await zx.readBarcodes(img, { ...ZX_OPTS, returnErrors: true, maxNumberOfSymbols: 255 });
    return { ids: uniqueIds(found.filter(r => r.isValid).map(r => r.text)), misses: found.filter(r => !r.isValid).map(r => Object.values(r.position)) };
  };
  let misses = null, layout;
  // JPEG photos are read straight from the file at full size; others (a PNG can be see-through) via the browser.
  if (file.type === "image/jpeg") {
    try {
      const r = await read(file);
      if (r.ids.length) return r.ids;
      if (!r.misses.length) return [];
      [misses, layout] = [r.misses, await jpegLayout(file)];
    } catch {} // fall through and let the browser decode it
  }
  const bmp = await toBitmap(file);
  try {
    if (misses) misses = misses.map(pts => upright(pts, layout, bmp));
    else {
      const px = pixelsOf(bmp), shrink = px.width / bmp.width;
      misses = [];
      for (const img of onSolidBackground(px)) {
        const r = await read(img);
        if (r.ids.length) return r.ids;
        misses.push(...r.misses.map(pts => pts.map(({ x, y }) => ({ x: x / shrink, y: y / shrink }))));
      }
    }
    seen.misses = misses;
    return await readNearMisses(zx, bmp, misses);
  } finally { bmp.close?.(); }
}

// A code that is small, turned or blurry in the photo is often found but not read.
// The small near-misses are cut out, enlarged and sharpened, then read again. In
// tests this found codes about 20% smaller (so from about 20% further away).
async function readNearMisses(zx, bmp, misses) {
  const short = Math.min(bmp.width, bmp.height), boxes = [];
  for (const pts of misses) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y, size = Math.max(w, h);
    if (size < 16 || size > short * 0.07) continue;
    // the same spot often comes back more than once
    if (boxes.some(b => Math.abs(b.x + b.w / 2 - x - w / 2) + Math.abs(b.y + b.h / 2 - y - h / 2) < size / 4)) continue;
    if (boxes.push({ x, y, w, h, size }) === 6) break;
  }
  for (const { x, y, w, h, size } of boxes) {
    const margin = size * 0.35, zoom = Math.min(5, Math.max(2, 240 / size));
    const img = sharpen(cutOut(bmp, x - margin, y - margin, w + 2 * margin, h + 2 * margin, zoom), 1.5 * zoom, 3);
    const ids = uniqueIds((await zx.readBarcodes(img, ZX_OPTS)).filter(r => r.isValid).map(r => r.text));
    if (ids.length) return ids;
  }
  return [];
}

// Part of the photo, enlarged smoothly, on white.
function cutOut(bmp, x, y, w, h, zoom) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(bmp.width - x, Math.ceil(w)); h = Math.min(bmp.height - y, Math.ceil(h));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(w * zoom), height: Math.round(h * zoom) });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Grey copy with sharper edges: grey + amount * (grey - blurred grey). The blur is
// three box blurs, close to a Gaussian with this sigma.
function sharpen(img, sigma, amount) {
  const { width: w, height: h, data } = img, n = w * h;
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) grey[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)), span = 2 * r + 1;
  const blur = Float32Array.from(grey), tmp = new Float32Array(n);
  const pass = (src, dst, len, lines, step, next) => {
    for (let l = 0; l < lines; l++) {
      const o = l * next, at = k => src[o + Math.min(len - 1, Math.max(0, k)) * step];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < len; k++) { dst[o + k * step] = sum / span; sum += at(k + r + 1) - at(k - r); }
    }
  };
  for (let i = 0; i < 3; i++) { pass(blur, tmp, w, h, 1, w); pass(tmp, blur, h, w, w, 1); }
  const out = new ImageData(w, h), o = out.data;
  for (let i = 0; i < n; i++) { o[4 * i] = o[4 * i + 1] = o[4 * i + 2] = grey[i] + amount * (grey[i] - blur[i]); o[4 * i + 3] = 255; }
  return out;
}

// How a JPEG's pixels are stored: width, height and EXIF turn (1 = upright). The
// reader sees them as stored; the browser turns the photo upright, as on screen.
async function jpegLayout(file) {
  let turn = 1, w = 0, h = 0;
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    for (let i = 2; i + 9 < v.byteLength && !w; i += 2 + v.getUint16(i + 2)) {
      const marker = v.getUint16(i);
      if (marker === 0xffe1 && v.getUint32(i + 4) === 0x45786966) { // "Exif"
        const t = i + 10, le = v.getUint16(t) === 0x4949, ifd = t + v.getUint32(t + 4, le);
        for (let n = v.getUint16(ifd, le), e = ifd + 2; n > 0; n--, e += 12) if (v.getUint16(e, le) === 0x0112) turn = v.getUint16(e + 8, le);
      } else if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
        h = v.getUint16(i + 5); w = v.getUint16(i + 7);
      }
    }
  } catch {}
  return { turn: turn >= 1 && turn <= 8 ? turn : 1, w, h };
}

// Moves points from a JPEG's stored pixels to the photo as the browser decoded it.
function upright(pts, { turn, w, h }, bmp) {
  // A browser that didn't turn the photo gives it its stored size.
  if (turn === 1 || !w || !h || (turn >= 5 && w !== h && bmp.width === w && bmp.height === h)) return pts;
  return pts.map(({ x, y }) => [
    { x, y }, { x: w - x, y }, { x: w - x, y: h - y }, { x, y: h - y },
    { x: y, y: x }, { x: h - y, y: x }, { x: h - y, y: w - x }, { x: y, y: w - x },
  ][turn - 1]);
}

// Fallback: the phone's own detector if it has one, then jsQR on the whole photo,
// on 2x2 pieces and on 3x3 pieces at full resolution (small codes need ~3 px per square).
async function slowGarmentIds(file) {
  const bmp = await toBitmap(file);
  try {
    if ("BarcodeDetector" in window) {
      try {
        detector ??= new BarcodeDetector({ formats: ["qr_code"] });
        const ids = uniqueIds((await detector.detect(bmp)).map(c => c.rawValue));
        if (ids.length) return ids;
      } catch {}
    }
    const jsQR = await loadJsQR();
    const W = bmp.width, H = bmp.height;
    for (const [grid, tile] of [[1, 1200], [2, 1200], [3, 2100]]) {
      const tw = W / grid, th = H / grid, ov = grid > 1 ? 0.25 : 0;
      for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
        const sx = Math.max(0, (gx - ov) * tw), sy = Math.max(0, (gy - ov) * th);
        const sw = Math.min(W - sx, tw * (1 + 2 * ov)), sh = Math.min(H - sy, th * (1 + 2 * ov));
        for (const px of onSolidBackground(pixelsOf(bmp, sx, sy, sw, sh, (tile * tile * sw * sh) / Math.max(sw, sh) ** 2))) {
          const id = idFromQr(jsQR(px.data, px.width, px.height, { inversionAttempts: "attemptBoth" })?.data);
          if (id) return [id];
        }
        await new Promise(r => setTimeout(r)); // let the screen update
      }
    }
    return [];
  } finally { bmp.close?.(); }
}

// ---------- your own codes, too far away to read ----------

// When none of your codes can be read in a photo, a second look (far-finder.js, in the
// background) checks for your garments only. It knows what each of your codes looks like,
// so it can recognise one about half the size the normal reader needs, or one the reader
// found but couldn't read (blurry, or seen in a mirror). That is less certain than reading
// the code, so you pick which of these photos to add.
let farWorker = null, farStop = null;
function stopFarFinder() {
  farWorker?.terminate();
  farWorker = null;
  farStop?.(new Error("Stopped"));
  farStop = null;
}

// The photo as grey levels, one byte per pixel (scale: its size over the photo's, below 1 for huge photos).
async function grayOf(file) {
  const bmp = await toBitmap(file);
  let px, scale;
  try { px = onSolidBackground(pixelsOf(bmp))[0]; scale = px.width / bmp.width; } finally { bmp.close?.(); }
  const { width, height, data } = px, gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return { gray, width, height, scale };
}

// Resolves to [{ id, box }]: box is the code's four corners as shares of the photo's width and height.
// misses: codes the normal reader found but couldn't read (garmentIdsInPhoto's seen.misses), checked first.
async function ownCodesFarAway(file, ids, misses = []) {
  const { gray, width, height, scale } = await grayOf(file);
  const hints = misses.map(pts => pts.map(({ x, y }) => [x * scale, y * scale]));
  farWorker ??= new Worker("/g/far-finder.js");
  const found = await new Promise((resolve, reject) => {
    farStop = reject;
    farWorker.onmessage = e => { farStop = null; e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.found); };
    farWorker.onerror = e => { e.preventDefault(); stopFarFinder(); reject(new Error(e.message || "The second look stopped")); };
    farWorker.postMessage({ gray, width, height, ids, hints }, [gray.buffer]);
  });
  return found.map(f => ({ id: f.id, box: f.corners.map(([x, y]) => [x / width, y / height]) }));
}

// A square close-up around a found code, with a ring around the code, as an image URL.
async function closeUp(file, box) {
  const bmp = await toBitmap(file);
  try {
    const W = bmp.width, H = bmp.height, xs = box.map(p => p[0] * W), ys = box.map(p => p[1] * H);
    const code = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const size = Math.min(W, H, Math.max(code * 10, 200));
    const sx = Math.max(0, Math.min(W - size, cx - size / 2)), sy = Math.max(0, Math.min(H - size, cy - size / 2));
    const out = 360, k = out / size;
    const canvas = Object.assign(document.createElement("canvas"), { width: out, height: out });
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, sx, sy, size, size, 0, 0, out, out);
    ctx.lineWidth = 3;
    for (const [color, grow] of [["#fff", 0], ["#2a3fe0", 3]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc((cx - sx) * k, (cy - sy) * k, code * k * 0.85 + 6 + grow, 0, 2 * Math.PI);
      ctx.stroke();
    }
    return await new Promise(res => canvas.toBlob(b => res(URL.createObjectURL(b)), "image/jpeg", 0.85));
  } finally { bmp.close?.(); }
}

// Shows the photos only the second look found (m.view: close-up URL); resolves to the ones you keep ticked.
function confirmFarFinds(maybe) {
  return new Promise(resolve => {
    const items = maybe.map(m => {
      const box = h("input", { type: "checkbox", checked: true, "aria-label": "Add this photo" });
      return { m, box, el: h("label", { class: "pick" }, h("img", { src: m.view, alt: "" }), box) };
    });
    let picked = [];
    const d = sheet(h("h2", null, `Maybe yours: ${maybe.length} more ${maybe.length === 1 ? "photo" : "photos"}`), h("div", { class: "stack" },
      h("p", { class: "small" }, `Your garment's code was too small or blurry to read for sure in ${maybe.length === 1 ? "this one" : "these"}, but it looks like yours. It's in the ring. Untick any that don't show your garment.`),
      h("div", { class: "picks" }, items.map(i => i.el)),
      h("button", { class: "btn primary block", onclick: () => { picked = items.filter(i => i.box.checked).map(i => i.m); d.close(); } }, "Add the ticked photos"),
      h("button", { class: "btn block", onclick: () => d.close() }, "Skip them")));
    d.addEventListener("close", () => { maybe.forEach(m => m.view && URL.revokeObjectURL(m.view)); resolve(picked); });
  });
}

// targets: { garmentId: name } for garments this phone owns
async function findPhotos(targets) {
  const files = await pickPhotos();
  if (!files.length) return;
  let cancelled = false;
  const bar = h("span");
  const line = h("p", { class: "small" });
  const stop = () => { cancelled = true; stopFarFinder(); };
  const d = sheet(h("h2", null, "Looking for your garments"), h("div", { class: "stack" },
    h("div", { class: "progress" }, bar), line,
    h("button", { class: "btn block", onclick: stop }, "Stop")));
  d.addEventListener("cancel", e => { e.preventDefault(); stop(); });

  // counted per photo: one photo can show two of your garments and go to both galleries
  const added = {}, failed = [], maybe = [];
  let checked = 0, matched = 0, fresh = 0, already = 0, other = 0, farJob = Promise.resolve();
  const update = () => {
    line.textContent = `Checked ${checked} of ${files.length} photos · found ${matched + maybe.length}`;
    bar.style.width = `${(checked / files.length) * 100}%`;
  };
  const upload = async (ids, file) => {
    let isNew = false, broke = false;
    for (const id of ids) {
      const r = await uploadPhotos(id, [file]);
      if (r.done) { added[id] = (added[id] || 0) + 1; isNew = true; }
      if (r.failed) { failed.push(r.lastError); broke = true; }
    }
    return isNew ? "new" : broke ? "failed" : "already";
  };
  update();
  for (const file of files) {
    if (cancelled) break;
    let ids = [];
    const seen = {};
    try { ids = await garmentIdsInPhoto(file, seen); } catch {}
    const mine = ids.filter(x => x in targets);
    if (mine.length) {
      const r = await upload(mine, file);
      matched++;
      if (r === "new") fresh++; else if (r === "already") already++;
      checked++;
    } else {
      // The second look runs while the next photo is read; one photo at a time.
      await farJob;
      if (cancelled) break;
      farJob = ownCodesFarAway(file, Object.keys(targets), seen.misses)
        .then(async found => {
          if (found.length) maybe.push({ file, found, view: await closeUp(file, found[0].box).catch(() => null) });
          else if (ids.length) other++;
        })
        .catch(() => { if (ids.length) other++; })
        .finally(() => { checked++; update(); });
    }
    update();
  }
  await farJob;
  stopFarFinder();
  d.close();

  let unticked = 0;
  if (maybe.length) {
    const keep = await confirmFarFinds(maybe);
    unticked = maybe.length - keep.length;
    for (const m of keep) {
      const r = await upload(m.found.map(f => f.id), m.file);
      matched++;
      if (r === "new") fresh++; else if (r === "already") already++;
    }
  }

  const total = fresh;
  const none = checked - matched - other - unticked;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const s = sheet(h("h2", null, total > 0 ? `Added ${plural(total, "photo", "photos")}` : "No new photos found"), h("div", { class: "stack" },
    Object.entries(added).map(([id, n]) => h("p", null, h("b", null, `${n}`), ` to ${targets[id]}`)),
    already > 0 && h("p", { class: "muted small" }, `${plural(already, "was", "were")} already in the gallery.`),
    other > 0 && h("p", { class: "muted small" }, `${plural(other, "photo showed a spår garment that isn't", "photos showed spår garments that aren't")} yours on this phone, so ${other === 1 ? "it was" : "they were"} skipped.`),
    none > 0 && h("p", { class: "muted small" },
      `In ${plural(none, "photo", "photos")} no code could be read. That's normal when the code is small, folded or blurry. You can still add those by hand: open the garment, tap Add photos, then Pick photos myself.`),
    failed.length > 0 && h("p", { class: "error" }, `${failed.length} couldn't be uploaded: ${failed[0]}`),
    h("button", { class: "btn primary block", onclick: () => { s.close(); location.reload(); } }, "Done")));
}

// ---------- screen: home ----------

function homeScreen() {
  const list = store.get();
  const input = h("input", { type: "text", class: "code", maxlength: 6, autocapitalize: "characters", autocomplete: "off",
    spellcheck: "false", placeholder: "4UC2J8", "aria-label": "Garment code" });
  const err = h("p", { class: "error", hidden: true });
  const open = e => {
    e.preventDefault();
    const id = input.value.trim().toUpperCase();
    if (!ID_RE.test(id)) { err.textContent = "A garment code has 6 letters and digits, like 4UC2J8."; err.hidden = false; return; }
    location.href = `/g/${id}`;
  };
  render(
    h("div", { class: "hero" }, h("h1", null, "Your garments"),
      h("p", null, "Scan the code on a spår garment with your camera to open its gallery.")),
    list.length
      ? h("div", { class: "list" }, list.map(g =>
          h("a", { class: "gitem", href: `/g/${g.id}` },
            g.thumb ? h("img", { class: "ph", src: photoUrl(g.id, g.thumb, "thumb"), alt: "" }) : h("span", { class: "ph" }, g.id),
            h("span", null, h("b", null, garmentName(g)), h("span", { class: "label" }, g.owner ? `${g.id} · yours` : g.id)),
            h("span", { "aria-hidden": "true" }, "›"))))
      : h("div", { class: "empty" }, "Garments you open show up here."),
    list.some(g => g.owner) && h("div", { class: "card" }, h("h2", null, "Find your garments in your photos"),
      h("p", { class: "muted small" }, "Select a batch of photos from your camera roll. Every photo where the app can read one of your garments' QR codes goes into that garment's gallery. The others never leave your phone."),
      h("button", { class: "btn primary block", onclick: () =>
        findPhotos(Object.fromEntries(store.get().filter(g => g.owner).map(g => [g.id, garmentName(g)]))) }, "Choose photos")),
    h("div", { class: "card" }, h("h2", null, "Type a code instead"),
      h("form", { class: "stack", onsubmit: open },
        h("label", { class: "field" }, h("span", { class: "label" }, "6-character code under the QR"), input), err,
        h("button", { class: "btn primary block", type: "submit" }, "Open")),
      "BarcodeDetector" in window && h("button", { class: "btn block", onclick: scanSheet }, "Scan with this app")),
    installCard());
}

async function scanSheet() {
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const d = sheet(h("h2", null, "Point at the code"), h("div", { class: "stack" }, h("div", { class: "scanbox" }, video),
    h("button", { class: "btn block", onclick: () => d.close() }, "Cancel")));
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch { d.close(); return toast("Camera not available. Use your phone's camera app instead."); }
  video.srcObject = stream;
  d.addEventListener("close", () => stream.getTracks().forEach(t => t.stop()));
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (!d.open) return;
    try {
      for (const code of await detector.detect(video)) {
        const m = /\/g\/([23456789A-Z]{6})\b/i.exec(code.rawValue);
        if (m) { d.close(); location.href = `/g/${m[1].toUpperCase()}`; return; }
      }
    } catch {}
    setTimeout(tick, 250);
  };
  video.addEventListener("playing", tick, { once: true });
}

// ---------- screen: admin ----------

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()));
  if (!head) return [];
  const cols = head.map(x => x.trim().toLowerCase());
  return body.map(r => Object.fromEntries(cols.map((c, i) => [c, (r[i] || "").trim()])));
}

function adminScreen() {
  document.title = "Gallery admin · spår";
  let saved = "";
  try { saved = sessionStorage.getItem("spar.admin") || ""; } catch {}
  const pass = h("input", { type: "password", autocomplete: "current-password", value: saved });
  const files = h("input", { type: "file", accept: ".csv,text/csv", multiple: true });
  const out = h("div", { class: "stack small" });
  const say = (msg, cls) => out.prepend(h("p", { class: cls || "" }, msg));
  const call = async (path, opts) => {
    try { sessionStorage.setItem("spar.admin", pass.value); } catch {}
    const res = await fetch(`/api/g/admin/${path}`, { ...opts, headers: { "x-spar": "1", authorization: `Bearer ${pass.value}`, "content-type": "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed");
    return data;
  };
  const stats = async () => {
    try {
      const s = await call("stats");
      say(`${s.garments} garments in the gallery, ${s.claimed} claimed, ${s.photos} photos (${(s.bytes / 1e6).toFixed(1)} MB).`);
    } catch (e) { say(e.message, "error"); }
  };
  const importCsv = async () => {
    for (const f of files.files) {
      const rows = parseCsv(await f.text());
      if (!rows.length || !("id" in rows[0]) || !("claim_code" in rows[0])) { say(`${f.name}: not a register file from the QR generator.`, "error"); continue; }
      let added = 0, existing = 0, invalid = [];
      try {
        for (let i = 0; i < rows.length; i += 1000) {
          const r = await call("import", { method: "POST", body: JSON.stringify({ rows: rows.slice(i, i + 1000) }) });
          added += r.added; existing += r.existing; invalid = invalid.concat(r.invalid);
        }
        say(`${f.name}: ${added} new garments added, ${existing} were already there${invalid.length ? `, ${invalid.length} rows skipped (${invalid.slice(0, 5).join(", ")})` : ""}.`);
      } catch (e) { say(`${f.name}: ${e.message}`, "error"); }
    }
    files.value = "";
  };
  render(
    h("div", { class: "hero" }, h("h1", null, "Gallery admin"),
      h("p", null, "Load the register CSV from the QR generator here, so every printed code opens its gallery. Loading the same file twice is safe.")),
    h("div", { class: "card" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Admin password (ADMIN_TOKEN)"), pass),
      h("label", { class: "field" }, h("span", { class: "label" }, "Register CSV files"), files),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: importCsv }, "Load register"),
        h("button", { class: "btn", onclick: stats }, "Show numbers"))),
    h("div", { class: "card" }, out));
}

// ---------- start ----------

function render(...nodes) { app.replaceChildren(...nodes.flat().filter(Boolean)); }

const seg = decodeURIComponent(location.pathname.replace(/^\/g\/?/, "").split("/")[0] || "");
if (!seg) homeScreen();
else if (seg.toLowerCase() === "admin") adminScreen();
else garmentScreen(seg.toUpperCase());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/g/sw.js", { scope: "/g/" }).catch(() => {});
