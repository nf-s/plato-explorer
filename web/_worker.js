import { handleAuthRequest, requireAccess } from "../worker/auth/index.mjs";

// Pages serves the app and the public realms' graphs and search indexes as
// static assets. Only the paths in the staged _routes.json reach this Function:
// sign-in, each public realm's articles and everything in a restricted realm.
const DATA =
  /^\/data\/([a-z][a-z0-9-]*)\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json)$/;
const ARTICLE = /^articles\/[A-Za-z0-9-]+\.json$/;
// The full realm list, for a signed-in viewer's realm menu.
const REALM_LIST = "/api/realms";
// Static assets on Pages are revalidated on every use; articles match.
const PUBLIC_CACHE = "public, max-age=0, must-revalidate";
// A restricted file is checked against the session each time it is used.
const RESTRICTED_CACHE = "private, no-cache";

// web/_headers does not apply to responses from a Function.
const HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function respond(body, status, headers = new Headers()) {
  for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
  return new Response(body, { status, headers });
}

function json(value, status) {
  return respond(
    JSON.stringify(value),
    status,
    new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  );
}

// A realm is public only when the release names it. Without the list every
// realm needs a session.
function publicRealms(env) {
  return new Set(
    typeof env.PUBLIC_REALMS === "string" ? env.PUBLIC_REALMS.split(",") : [],
  );
}

// R2 rejects a conditional header it cannot parse. The file is then sent in full.
async function read(bucket, key, headers) {
  try {
    return await bucket.get(key, { onlyIf: headers });
  } catch {
    return bucket.get(key);
  }
}

async function stored(request, env, key, restricted) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return respond(null, 405, new Headers({ Allow: "GET, HEAD" }));
  if (restricted) {
    const access = await requireAccess(request, env);
    if (access.response)
      return respond(
        access.response.body,
        access.response.status,
        new Headers(access.response.headers),
      );
  }
  const object =
    request.method === "HEAD"
      ? await env.ARTICLES.head(key)
      : await read(env.ARTICLES, key, request.headers);
  if (object === null) return respond("Not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", restricted ? RESTRICTED_CACHE : PUBLIC_CACHE);
  if (restricted) headers.set("Vary", "Cookie");
  if (request.method === "HEAD") return respond(null, 200, headers);
  // A conditional request whose copy is current gets the object without a body.
  if (!("body" in object)) return respond(null, 304, headers);
  return respond(object.body, 200, headers);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === REALM_LIST)
      return stored(request, env, "realms.json", true);
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/"))
      return (
        (await handleAuthRequest(request, env, {
          signInFailureUrl: (code) => `/?signin=${encodeURIComponent(code)}`,
        })) ?? json({ error: "not_found", message: "Not found." }, 404)
      );
    const match = DATA.exec(pathname);
    if (!match) return env.ASSETS.fetch(request);
    const [, realm, file] = match;
    if (!publicRealms(env).has(realm))
      return stored(request, env, `${realm}/${file}`, true);
    if (!ARTICLE.test(file)) return env.ASSETS.fetch(request);
    return stored(request, env, `${realm}/${file}`, false);
  },
};
