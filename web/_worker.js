// A release keeps each article as one object in object storage. Pages serves
// every other file as a static asset and sends only article requests here, as
// listed in the staged _routes.json.
const ARTICLE = /^\/data\/([a-z][a-z0-9-]*)\/articles\/([A-Za-z0-9-]+)\.json$/;

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

// R2 rejects a conditional header it cannot parse. The article is then sent in full.
async function read(bucket, key, headers) {
  try {
    return await bucket.get(key, { onlyIf: headers });
  } catch {
    return bucket.get(key);
  }
}

export default {
  async fetch(request, env) {
    const match = ARTICLE.exec(new URL(request.url).pathname);
    if (!match) return env.ASSETS.fetch(request);
    const key = `${match[1]}/articles/${match[2]}.json`;
    if (request.method !== "GET" && request.method !== "HEAD")
      return respond(null, 405, new Headers({ Allow: "GET, HEAD" }));
    const object =
      request.method === "HEAD"
        ? await env.ARTICLES.head(key)
        : await read(env.ARTICLES, key, request.headers);
    if (object === null) return respond("Not found", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    // Static assets on Pages are revalidated on every use; articles match.
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    if (request.method === "HEAD") return respond(null, 200, headers);
    // A conditional request whose copy is current gets the object without a body.
    if (!("body" in object)) return respond(null, 304, headers);
    return respond(object.body, 200, headers);
  },
};
