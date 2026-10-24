// /g/{ID}, /g/ and /g/admin all open the gallery app (public/g/index.html),
// which reads the ID from the address. Files like /g/app.js are served as-is.
export const onRequest = ({ request, env, next }) => {
  const url = new URL(request.url);
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return next();
  if (url.pathname === "/g") return Response.redirect(`${url.origin}/g/`, 301);
  return env.ASSETS.fetch(new Request(new URL("/g/", url), request));
};
