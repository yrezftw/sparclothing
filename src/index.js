// The sparclothing.se Worker. The shop pages and the gallery app are plain files
// in public/ (the ASSETS binding). This script runs first for every request: it
// forwards the shop's other addresses, runs the Stripe checkout and the garment
// gallery's server, and opens the gallery app at /g/{ID}.
import { handleCheckout } from "./checkout.js";
import { handleGalleryApi } from "./gallery-api.js";

// The other addresses forward to sparclothing.se with the same path, so owner
// cookies and search engines only ever see one address. Each name also has to be
// added as a custom domain on the Worker (see GO-LIVE.md). The workers.dev
// address is left alone so a deploy can be tried before the domain works.
const HOME = "sparclothing.se";
const FORWARD = new Set([
  "www.sparclothing.se",
  "xn--sprclothing-y8a.se", // spårclothing.se
  "www.xn--sprclothing-y8a.se",
]);

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (FORWARD.has(url.hostname)) {
      url.protocol = "https:";
      url.hostname = HOME;
      url.port = "";
      return Response.redirect(url.href, 301);
    }

    const path = url.pathname;
    if (path === "/api/checkout") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      return handleCheckout(request, env);
    }
    if (path.startsWith("/api/g/")) return handleGalleryApi(request, env, path.slice("/api/g/".length).split("/").filter(Boolean));

    // /g/{ID}, /g/ and /g/admin all open the gallery app (public/g/index.html),
    // which reads the ID from the address. Files like /g/app.js are served as-is.
    if (path === "/g") return Response.redirect(`${url.origin}/g/`, 301);
    if (path.startsWith("/g/") && !/\.[a-z0-9]+$/i.test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/g/", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
