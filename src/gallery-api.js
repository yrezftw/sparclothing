// spår garment galleries: the server side.
// Every garment has a 6-char ID (from the QR generator) and a secret claim code
// on its inside label. Whoever enters the claim code owns the gallery on that
// phone. Photos live in R2 (env.PHOTOS), everything else in D1 (env.DB).
//
// Routes (all under /api/g/):
//   GET    {id}                         gallery info + photos the caller may see
//   PATCH  {id}                         owner: title, visibility, guest uploads
//   POST   {id}/claim      {code}       claim code -> owner cookie on this phone
//   POST   {id}/logout                  forget this phone
//   POST   {id}/release                 owner: wipe photos, free garment for the next owner
//   POST   {id}/photos     multipart    add a photo (owner: live, others: waits for approval)
//   PATCH  {id}/photos/{pid}            owner: approve
//   DELETE {id}/photos/{pid}            owner: delete
//   GET    {id}/photos/{pid}/{full|thumb}
//   POST   admin/import    [rows]       Rasmus: load the QR register (Bearer ADMIN_TOKEN)
//   GET    admin/stats

export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // same as the QR generator
const ID_RE = new RegExp(`^[${ALPHABET}]{6}$`);
const CODE_RE = new RegExp(`^[${ALPHABET}]{8}$`);

const LIMITS = {
  fullBytes: 4 * 1024 * 1024,
  thumbBytes: 400 * 1024,
  photosPerGarment: 500,
  pendingPerGarment: 100,
  claimFailsPerHour: 10,
  titleLength: 60,
  nameLength: 40,
};
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // browsers cap cookies at 400 days

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS garments (
     id TEXT PRIMARY KEY, claim_hash TEXT NOT NULL, product TEXT, size TEXT, batch TEXT, created TEXT,
     claimed_at INTEGER, title TEXT, visibility TEXT NOT NULL DEFAULT 'private',
     guest_uploads INTEGER NOT NULL DEFAULT 1, imported_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, garment_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_garment ON sessions(garment_id)`,
  `CREATE TABLE IF NOT EXISTS photos (
     id TEXT PRIMARY KEY, garment_id TEXT NOT NULL, status TEXT NOT NULL, by_owner INTEGER NOT NULL,
     uploader TEXT, width INTEGER, height INTEGER, bytes INTEGER, created_at INTEGER NOT NULL, source_hash TEXT)`,
  `CREATE INDEX IF NOT EXISTS photos_source ON photos(garment_id, source_hash)`,
  `CREATE INDEX IF NOT EXISTS photos_garment ON photos(garment_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS claim_fails (garment_id TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS claim_fails_garment ON claim_fails(garment_id, ts)`,
];

let schemaReady = null;
function ensureSchema(db) {
  // Tables create themselves on first use, so setup needs no database console.
  schemaReady ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const now = () => Math.floor(Date.now() / 1000);

function randomString(len) {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const normalizeId = s => String(s ?? "").trim().toUpperCase();
export const normalizeCode = s => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const claimHash = (id, code) => sha256(`spar-claim:${id}:${code}`);

function cookieName(id) { return `spar_o_${id}`; }
function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
function ownerCookie(id, token, maxAge = COOKIE_MAX_AGE) {
  return `${cookieName(id)}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function isOwner(env, request, id) {
  const token = readCookie(request, cookieName(id));
  if (!token) return false;
  const row = await env.DB.prepare("SELECT garment_id FROM sessions WHERE token_hash = ?")
    .bind(await sha256(token)).first();
  return row?.garment_id === id;
}

async function getGarment(env, id) {
  if (!ID_RE.test(id)) fail(404, "That isn't a spår garment code");
  const g = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(id).first();
  if (!g) fail(404, "We can't find this garment. Check the code on the label.");
  return g;
}

// Re-writes a JPEG without its metadata segments (EXIF, GPS, XMP, comments).
// The app already re-encodes photos before upload; this makes sure of it.
export function stripJpeg(u8) {
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) fail(400, "Photos must be JPEG");
  const parts = [u8.subarray(0, 2)];
  let i = 2;
  while (i < u8.length) {
    if (u8[i] !== 0xff) fail(400, "That photo file is damaged");
    let j = i + 1;
    while (u8[j] === 0xff) j++; // fill bytes
    const marker = u8[j];
    if (marker === undefined) break;
    if (marker === 0xda) { parts.push(u8.subarray(i)); break; } // image data starts: keep the rest
    if (marker === 0xd9) { parts.push(u8.subarray(i, j + 1)); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(u8.subarray(i, j + 1)); i = j + 1; continue; }
    if (j + 2 >= u8.length) fail(400, "That photo file is damaged");
    const len = (u8[j + 1] << 8) | u8[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > u8.length) fail(400, "That photo file is damaged");
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) parts.push(u8.subarray(i, end));
    i = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const photoView = p => ({
  id: p.id, w: p.width, h: p.height, byOwner: !!p.by_owner,
  name: p.uploader || null, created: p.created_at, status: p.status,
});

// ---------- handlers ----------

async function getGallery(env, request, id) {
  const g = await getGarment(env, id);
  const owner = await isOwner(env, request, id);
  const claimed = !!g.claimed_at;
  const canSee = owner || (claimed && g.visibility === "public");
  const body = {
    id, claimed, owner,
    product: g.product || null,
    title: claimed ? g.title || null : null,
    visibility: g.visibility,
    guestUploads: claimed && !!g.guest_uploads,
    photos: [],
    pending: [],
  };
  if (canSee) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM photos WHERE garment_id = ? ORDER BY created_at DESC, id").bind(id).all();
    body.photos = results.filter(p => p.status === "approved").map(photoView);
    if (owner) body.pending = results.filter(p => p.status === "pending").map(photoView);
  }
  return json(body);
}

async function patchGallery(env, request, id) {
  await getGarment(env, id);
  if (!(await isOwner(env, request, id))) fail(403, "Only the owner can change this");
  const b = await readJson(request);
  const sets = [], vals = [];
  if ("title" in b) {
    const t = String(b.title ?? "").trim().slice(0, LIMITS.titleLength);
    sets.push("title = ?"); vals.push(t || null);
  }
  if ("visibility" in b) {
    if (!["public", "private"].includes(b.visibility)) fail(400, "Unknown visibility");
    sets.push("visibility = ?"); vals.push(b.visibility);
  }
  if ("guestUploads" in b) { sets.push("guest_uploads = ?"); vals.push(b.guestUploads ? 1 : 0); }
  if (sets.length) await env.DB.prepare(`UPDATE garments SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return getGallery(env, request, id);
}

async function claim(env, request, id) {
  const g = await getGarment(env, id);
  const hourAgo = now() - 3600;
  const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_fails WHERE garment_id = ? AND ts > ?")
    .bind(id, hourAgo).first();
  if (fails.n >= LIMITS.claimFailsPerHour) fail(429, "Too many wrong tries. Wait an hour and try again.");

  const code = normalizeCode((await readJson(request)).code);
  if (!CODE_RE.test(code) || (await claimHash(id, code)) !== g.claim_hash) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO claim_fails (garment_id, ts) VALUES (?, ?)").bind(id, now()),
      env.DB.prepare("DELETE FROM claim_fails WHERE ts < ?").bind(hourAgo),
    ]);
    fail(403, "That code doesn't match this garment. It's the 8-character code on the label inside.");
  }
  const token = randomString(40);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, garment_id, created_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), id, now()),
    env.DB.prepare("UPDATE garments SET claimed_at = COALESCE(claimed_at, ?) WHERE id = ?").bind(now(), id),
    env.DB.prepare("DELETE FROM claim_fails WHERE garment_id = ?").bind(id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": ownerCookie(id, token) });
}

async function logout(env, request, id) {
  const token = readCookie(request, cookieName(id));
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": ownerCookie(id, "", 0) });
}

async function deletePhotoFiles(env, id, pids) {
  const keys = pids.flatMap(pid => [`g/${id}/${pid}/full.jpg`, `g/${id}/${pid}/thumb.jpg`]);
  for (let i = 0; i < keys.length; i += 1000) await env.PHOTOS.delete(keys.slice(i, i + 1000));
}

async function release(env, request, id) {
  await getGarment(env, id);
  if (!(await isOwner(env, request, id))) fail(403, "Only the owner can do this");
  const { results } = await env.DB.prepare("SELECT id FROM photos WHERE garment_id = ?").bind(id).all();
  await deletePhotoFiles(env, id, results.map(r => r.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM photos WHERE garment_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE garment_id = ?").bind(id),
    env.DB.prepare(`UPDATE garments SET claimed_at = NULL, title = NULL, visibility = 'private',
                    guest_uploads = 1 WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": ownerCookie(id, "", 0) });
}

async function addPhoto(env, request, id) {
  const g = await getGarment(env, id);
  const owner = await isOwner(env, request, id);
  if (!g.claimed_at) fail(403, "This garment has no owner yet, so it can't take photos");
  if (!owner && !g.guest_uploads) fail(403, "The owner has turned off photos from others");

  const form = await request.formData().catch(() => fail(400, "Bad upload"));
  const full = form.get("full"), thumb = form.get("thumb");
  if (!(full instanceof File) || !(thumb instanceof File)) fail(400, "Bad upload");
  if (full.size > LIMITS.fullBytes || thumb.size > LIMITS.thumbBytes) fail(413, "That photo is too big");
  if (!owner && form.get("consent") !== "yes") fail(400, "Please tick the box to confirm you may share this photo");

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending FROM photos WHERE garment_id = ?`).bind(id).first();
  if (counts.total >= LIMITS.photosPerGarment) fail(409, "This gallery is full");
  if (!owner && (counts.pending || 0) >= LIMITS.pendingPerGarment) fail(429, "The owner has a lot of photos to approve. Try again later.");

  // The app sends a fingerprint of the original file, so picking the same photo twice adds it once.
  const hash = /^[0-9a-f]{32}$/.test(form.get("hash") || "") ? form.get("hash") : null;
  if (hash) {
    const dup = await env.DB.prepare("SELECT id, status FROM photos WHERE garment_id = ? AND source_hash = ?").bind(id, hash).first();
    if (dup) return json({ ok: true, id: dup.id, status: dup.status, duplicate: true });
  }

  const fullBytes = stripJpeg(new Uint8Array(await full.arrayBuffer()));
  const thumbBytes = stripJpeg(new Uint8Array(await thumb.arrayBuffer()));
  const int = (v, max) => Math.max(1, Math.min(max, parseInt(v, 10) || 1));
  const pid = randomString(12);
  const opts = { httpMetadata: { contentType: "image/jpeg" } };
  await env.PHOTOS.put(`g/${id}/${pid}/full.jpg`, fullBytes, opts);
  await env.PHOTOS.put(`g/${id}/${pid}/thumb.jpg`, thumbBytes, opts);
  const name = owner ? null : String(form.get("name") || "").trim().slice(0, LIMITS.nameLength) || null;
  await env.DB.prepare(
    `INSERT INTO photos (id, garment_id, status, by_owner, uploader, width, height, bytes, created_at, source_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(pid, id, owner ? "approved" : "pending", owner ? 1 : 0, name,
      int(form.get("w"), 20000), int(form.get("h"), 20000), fullBytes.length, now(), hash).run();
  return json({ ok: true, id: pid, status: owner ? "approved" : "pending" }, 201);
}

async function changePhoto(env, request, id, pid, method) {
  await getGarment(env, id);
  if (!(await isOwner(env, request, id))) fail(403, "Only the owner can do this");
  const p = await env.DB.prepare("SELECT id FROM photos WHERE id = ? AND garment_id = ?").bind(pid, id).first();
  if (!p) fail(404, "Photo not found");
  if (method === "DELETE") {
    await deletePhotoFiles(env, id, [pid]);
    await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(pid).run();
  } else {
    await env.DB.prepare("UPDATE photos SET status = 'approved' WHERE id = ?").bind(pid).run();
  }
  return json({ ok: true });
}

async function getPhotoFile(env, request, id, pid, size) {
  if (!["full", "thumb"].includes(size)) fail(404, "Not found");
  const g = await getGarment(env, id);
  const p = await env.DB.prepare("SELECT status FROM photos WHERE id = ? AND garment_id = ?").bind(pid, id).first();
  if (!p) fail(404, "Photo not found");
  const publicOk = g.claimed_at && g.visibility === "public" && p.status === "approved";
  if (!publicOk && !(await isOwner(env, request, id))) fail(403, "This photo is private");
  const obj = await env.PHOTOS.get(`g/${id}/${pid}/${size}.jpg`);
  if (!obj) fail(404, "Photo not found");
  return new Response(obj.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=604800",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="spar-${id}-${pid}.jpg"`,
    },
  });
}

// ---------- admin (Rasmus) ----------

async function requireAdmin(env, request) {
  if (!env.ADMIN_TOKEN) fail(503, "ADMIN_TOKEN isn't set in Cloudflare yet");
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // compare hashes so the check takes the same time whatever was typed; spaces at
  // either end are ignored, since a pasted password often brings one along
  if ((await sha256(given.trim())) !== (await sha256(env.ADMIN_TOKEN.trim()))) fail(401, "Wrong admin password");
}

async function adminImport(env, request) {
  await requireAdmin(env, request);
  const { rows } = await readJson(request);
  if (!Array.isArray(rows) || rows.length > 5000) fail(400, "Send at most 5000 rows at a time");
  let added = 0, existing = 0;
  const invalid = [];
  const stmts = [];
  for (const r of rows) {
    const id = normalizeId(r.id), code = normalizeCode(r.claim_code);
    if (!ID_RE.test(id) || !CODE_RE.test(code)) { invalid.push(r.id || "(empty)"); continue; }
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO garments (id, claim_hash, product, size, batch, created, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, await claimHash(id, code), str(r.product), str(r.size), str(r.batch), str(r.created), now()));
  }
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch(stmts.slice(i, i + 100));
    for (const r of res) (r.meta.changes ? added++ : existing++);
  }
  return json({ added, existing, invalid });
}
const str = v => (v == null || v === "" ? null : String(v).slice(0, 80));

async function adminStats(env, request) {
  await requireAdmin(env, request);
  const g = await env.DB.prepare(
    "SELECT COUNT(*) AS garments, COUNT(claimed_at) AS claimed FROM garments").first();
  const p = await env.DB.prepare(
    "SELECT COUNT(*) AS photos, COALESCE(SUM(bytes), 0) AS bytes FROM photos").first();
  return json({ ...g, ...p });
}

async function readJson(request) {
  try { return (await request.json()) ?? {}; } catch { fail(400, "Bad request"); }
}

// ---------- router ----------

export async function handleGalleryApi(request, env, segments) {
  try {
    if (!env.DB || !env.PHOTOS) fail(503, "The gallery isn't connected to its storage yet");
    const method = request.method;
    // Changes must come from our own pages: a JSON/multipart body plus this header,
    // which another site can't send with the owner's cookie.
    if (method !== "GET" && request.headers.get("x-spar") !== "1") fail(403, "Forbidden");
    await ensureSchema(env.DB);

    const [first, action, pid, size] = segments;
    if (first === "admin") {
      if (action === "import" && method === "POST") return await adminImport(env, request);
      if (action === "stats" && method === "GET") return await adminStats(env, request);
      fail(404, "Not found");
    }
    const id = normalizeId(first);
    if (!action) {
      if (method === "GET") return await getGallery(env, request, id);
      if (method === "PATCH") return await patchGallery(env, request, id);
    }
    if (action === "claim" && method === "POST") return await claim(env, request, id);
    if (action === "logout" && method === "POST") return await logout(env, request, id);
    if (action === "release" && method === "POST") return await release(env, request, id);
    if (action === "photos") {
      if (!pid && method === "POST") return await addPhoto(env, request, id);
      if (pid && !size && (method === "PATCH" || method === "DELETE")) return await changePhoto(env, request, id, pid, method);
      if (pid && size && method === "GET") return await getPhotoFile(env, request, id, pid, size);
    }
    fail(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("gallery error", e?.stack || e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}
