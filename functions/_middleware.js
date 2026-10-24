// The shop's other addresses forward to sparclothing.se with the same path, so
// owner cookies and search engines only ever see one address. Each name also
// has to be added under Custom domains in the Pages project (see SETUP.md).
// sparclothing.pages.dev is left alone so a deploy can be tried before the domain works.
const HOME = "sparclothing.se";
const FORWARD = new Set([
  "www.sparclothing.se",
  "xn--sprclothing-y8a.se", // spårclothing.se
  "www.xn--sprclothing-y8a.se",
]);

export const onRequest = ({ request, next }) => {
  const url = new URL(request.url);
  if (!FORWARD.has(url.hostname)) return next();
  url.protocol = "https:";
  url.hostname = HOME;
  url.port = "";
  return Response.redirect(url.href, 301);
};
