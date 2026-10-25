// Until the shop opens, every address shows an "Opening soon" page. The owner
// gets in by typing the admin password (ADMIN_TOKEN) once per browser, which
// sets a preview cookie for 400 days; after that a QR scan opens the gallery as
// normal. SITE_OPEN = "yes" in wrangler.toml opens the site to everyone.
const COOKIE = "spar_preview";
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

// The cookie holds an HMAC of the admin password, never the password itself,
// and stops working when the password is changed.
async function previewToken(env) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("spar-preview")));
}

// Compares digests so the time taken says nothing about how much of a guess was right.
async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

const readCookie = (request, name) =>
  (request.headers.get("cookie") ?? "").split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";

// Only paths on this site, so the form can't be used to send people elsewhere.
const localPath = p => (typeof p === "string" && /^\/(?![/\\])/.test(p) ? p : "/");

// Returns the response that stops this request at "Opening soon", or null when
// the request may go on to the site.
export async function previewGate(request, env, url) {
  if (env.SITE_OPEN === "yes") return null;
  const token = env.ADMIN_TOKEN ? await previewToken(env) : null;
  if (token && (await same(readCookie(request, COOKIE), token))) return null;

  if (url.pathname === "/preview" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const next = localPath(form?.get("next"));
    if (!token) return soonPage(next, "The admin password isn't set in Cloudflare yet.");
    if (!(await same(String(form?.get("password") ?? ""), env.ADMIN_TOKEN))) return soonPage(next, "That isn't the password.");
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "spårclothing isn't open yet" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return soonPage(url.pathname + url.search);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function soonPage(next, error = "") {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>spårclothing · Opening soon</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>
:root{--paper:#eceeeb;--card:#f7f8f6;--ink:#151a17;--muted:#5d665f;--line:#cdd2cc;--signal:#2a3fe0;--signal-ink:#fff;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--paper:#111412;--card:#191d1a;--ink:#e7ebe6;--muted:#98a29a;--line:#2d332f;--signal:#7d8cff;--signal-ink:#0b0e1f;--danger:#ff8a80;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:16px/1.55 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif}
main{width:100%;max-width:420px}
.brand{font:800 24px/1 "Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em}
h1{font:800 clamp(34px,9vw,48px)/1.05 "Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;margin:40px 0 10px}
p{margin:0;color:var(--muted)}
form{display:grid;gap:10px;margin-top:32px;padding-top:20px;border-top:1px solid var(--line)}
label{font-size:14px;color:var(--muted)}
input{font:inherit;color:inherit;min-height:48px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card)}
button{font:inherit;font-weight:600;min-height:48px;border:0;border-radius:999px;background:var(--signal);color:var(--signal-ink);cursor:pointer}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.error{color:var(--danger);font-size:14px}
</style></head>
<body><main>
<div class="brand">spårclothing</div>
<h1>Opening soon</h1>
<p>Clothes that keep every photo you're in.</p>
<form method="post" action="/preview">
<label for="pw">Have the password?</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required>
<input type="hidden" name="next" value="${esc(next)}">
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<button>Enter</button>
</form>
</main></body></html>`, {
    // 503, not 200: search engines treat it as temporary, and the gallery's
    // service worker only caches pages that came back OK.
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "retry-after": "86400" },
  });
}
