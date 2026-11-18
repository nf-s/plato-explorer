import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import worker from "../web/_worker.js";
import { COOKIE_NAMES } from "../worker/auth/index.mjs";
import { ENV, NOW, harness } from "../worker/auth/test-support.mjs";

const root = new URL("../", import.meta.url);
const ETAG = '"article-etag"';
const STORED = [
  "psychology/articles/nietzsche.json",
  "philosophy/articles/nietzsche.json",
  "philosophy/graph.json",
  "philosophy/search/shards/000.json",
  "realms.json",
];

const opened = [];
afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

// Stands in for the bindings: stored files with conditional reads, a record of
// the keys asked for, and an account database with Psychology as the one
// public realm.
function environment() {
  const access = harness();
  opened.push(access.binding);
  access.advance(Math.floor(Date.now() / 1000) - NOW);
  const keys = [];
  const assets = [];
  const stored = {
    httpEtag: ETAG,
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/json");
    },
  };
  const find = (key) => {
    keys.push(key);
    return STORED.includes(key);
  };
  return {
    ...access.env,
    PUBLIC_REALMS: "psychology",
    signIn: (identity) => access.login(identity),
    keys,
    assets,
    ARTICLES: {
      async head(key) {
        return find(key) ? stored : null;
      },
      async get(key, options) {
        if (!find(key)) return null;
        const condition = options ? options.onlyIf.get("If-None-Match") : null;
        if (condition !== null && !condition.startsWith('"'))
          throw new Error("invalid conditional header");
        return condition === ETAG
          ? stored
          : { ...stored, body: '{"id":"nietzsche"}' };
      },
    },
    ASSETS: {
      async fetch(request) {
        assets.push(new URL(request.url).pathname);
        return new Response("asset");
      },
    },
  };
}

function ask(env, path, init) {
  return worker.fetch(new Request(`${ENV.PUBLIC_URL}${path}`, init), env);
}

async function session(env) {
  const { sessionToken } = await env.signIn();
  return { headers: { Cookie: `${COOKIE_NAMES.session}=${sessionToken}` } };
}

const RESTRICTED = [
  "/data/philosophy/articles/nietzsche.json",
  "/data/philosophy/graph.json",
  "/data/philosophy/search/shards/000.json",
  "/api/realms",
];

test("an article request returns that article with the crawl and security headers", async () => {
  const env = environment();
  const response = await ask(env, "/data/psychology/articles/nietzsche.json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "nietzsche" });
  assert.deepEqual(env.keys, ["psychology/articles/nietzsche.json"]);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("ETag"), ETAG);
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=0, must-revalidate",
  );
  // Functions do not receive the static header rules, so the two must agree.
  const rules = await readFile(new URL("web/_headers", root), "utf8");
  for (const name of [
    "X-Robots-Tag",
    "X-Content-Type-Options",
    "Referrer-Policy",
  ])
    assert.ok(rules.includes(`  ${name}: ${response.headers.get(name)}\n`));
});

test("a current copy is confirmed without sending the article again", async () => {
  const env = environment();
  const response = await ask(env, "/data/psychology/articles/nietzsche.json", {
    headers: { "If-None-Match": ETAG },
  });
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("ETag"), ETAG);
});

test("a conditional header the bucket cannot parse gets the whole article", async () => {
  const env = environment();
  const response = await ask(env, "/data/psychology/articles/nietzsche.json", {
    headers: { "If-None-Match": "garbage" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "nietzsche" });
});

test("HEAD answers without a body and other methods are refused", async () => {
  const env = environment();
  const head = await ask(env, "/data/psychology/articles/nietzsche.json", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await ask(env, "/data/psychology/articles/nietzsche.json", {
    method: "POST",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
  assert.deepEqual(env.keys, ["psychology/articles/nietzsche.json"]);
});

test("a missing article is a 404 with the crawl header", async () => {
  const env = environment();
  const response = await ask(env, "/data/psychology/articles/absent.json");
  assert.equal(response.status, 404);
  assert.equal(
    response.headers.get("X-Robots-Tag"),
    "noindex, nofollow, noarchive, nosnippet",
  );
});

test("paths that are not one article go to the static assets and never to the bucket", async () => {
  const env = environment();
  const paths = [
    "/",
    "/data/realms.json",
    "/data/psychology/graph.json",
    "/data/psychology/search/shards/000.json",
    "/data/psychology/articles/",
    "/data/psychology/articles/a/b.json",
    "/data/psychology/articles/..%2Fgraph.json",
    "/data/Psychology/articles/nietzsche.json",
    "/data/psychology/articles/nietzsche.json.bak",
    "/data/philosophy/articles/..%2F..%2Frealms.json",
  ];
  for (const path of paths) assert.equal((await ask(env, path)).status, 200);
  assert.deepEqual(env.keys, []);
  assert.equal(env.assets.length, paths.length);
});

test("a restricted realm and the full realm list are refused without a session and never read", async () => {
  const env = environment();
  for (const method of ["GET", "HEAD"])
    for (const path of RESTRICTED) {
      const response = await ask(env, path, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(
        response.headers.get("X-Robots-Tag"),
        "noindex, nofollow, noarchive, nosnippet",
      );
    }
  const forged = await ask(env, RESTRICTED[0], {
    headers: { Cookie: `${COOKIE_NAMES.session}=${"a".repeat(43)}` },
  });
  assert.equal(forged.status, 401);
  assert.deepEqual(env.keys, []);
  assert.deepEqual(env.assets, []);
});

test("a signed-in account reads a restricted realm, privately and revalidated each time", async () => {
  const env = environment();
  const signedIn = await session(env);
  const keys = [];
  for (const path of RESTRICTED) {
    const response = await ask(env, path, signedIn);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Cache-Control"), "private, no-cache");
    assert.equal(response.headers.get("Vary"), "Cookie");
    assert.equal(response.headers.get("ETag"), ETAG);
    keys.push(env.keys.at(-1));
  }
  assert.deepEqual(keys, [
    "philosophy/articles/nietzsche.json",
    "philosophy/graph.json",
    "philosophy/search/shards/000.json",
    "realms.json",
  ]);
  const current = await ask(env, RESTRICTED[1], {
    headers: { ...signedIn.headers, "If-None-Match": ETAG },
  });
  assert.equal(current.status, 304);
  const post = await ask(env, RESTRICTED[1], { ...signedIn, method: "POST" });
  assert.equal(post.status, 405);
  assert.deepEqual(env.assets, []);
});

test("revoking an account ends its access to a restricted realm", async () => {
  const env = environment();
  const admin = await env.signIn();
  const reader = {
    email: "reader@gmail.com",
    sub: "reader-1",
    authoritativeEmail: true,
  };
  await assert.rejects(env.signIn(reader), { code: "access_denied" });
  const change = (method) =>
    ask(env, "/api/admin/access", {
      method,
      headers: {
        Cookie: `${COOKIE_NAMES.session}=${admin.sessionToken}`,
        "X-CSRF-Token": admin.csrfToken,
        Origin: ENV.PUBLIC_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: reader.email }),
    });
  assert.equal((await change("POST")).status, 200);
  const granted = await env.signIn(reader);
  const cookie = {
    headers: { Cookie: `${COOKIE_NAMES.session}=${granted.sessionToken}` },
  };
  assert.equal((await ask(env, RESTRICTED[1], cookie)).status, 200);
  assert.equal((await change("DELETE")).status, 200);
  assert.equal((await ask(env, RESTRICTED[1], cookie)).status, 401);
});

test("every realm needs a session when the release names no public realms", async () => {
  const env = environment();
  delete env.PUBLIC_REALMS;
  const response = await ask(env, "/data/psychology/articles/nietzsche.json");
  assert.equal(response.status, 401);
  assert.deepEqual(env.keys, []);
});

test("a restricted realm stays closed on another address and without sign-in settings", async () => {
  const env = environment();
  const signedIn = await session(env);
  const alias = await worker.fetch(
    new Request(`https://preview.example${RESTRICTED[1]}`, signedIn),
    env,
  );
  assert.equal(alias.status, 400);
  delete env.GOOGLE_CLIENT_SECRET;
  assert.equal((await ask(env, RESTRICTED[1], signedIn)).status, 503);
  assert.deepEqual(env.keys, []);
});

test("sign-in routes are answered by the account service and a failed sign-in returns to the app", async () => {
  const env = environment();
  const anonymous = await ask(env, "/api/session");
  assert.deepEqual(await anonymous.json(), { authenticated: false });
  const signedIn = await ask(env, "/api/session", await session(env));
  assert.equal((await signedIn.json()).email, ENV.ADMIN_EMAIL);
  const start = await ask(
    env,
    "/auth/google/start?next=%2F%3Frealm%3Dphilosophy",
  );
  assert.equal(start.status, 303);
  assert.equal(
    new URL(start.headers.get("Location")).origin,
    "https://accounts.google.com",
  );
  const failed = await ask(env, "/auth/google/callback?state=unknown");
  assert.equal(failed.status, 303);
  assert.equal(failed.headers.get("Location"), "/?signin=invalid_request");
  assert.equal((await ask(env, "/api/unknown")).status, 404);
  assert.equal((await ask(env, "/auth/unknown")).status, 404);
  assert.deepEqual(env.keys, []);
  assert.deepEqual(env.assets, []);
});
