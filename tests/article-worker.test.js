import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../web/_worker.js";

const root = new URL("../", import.meta.url);
const ETAG = '"article-etag"';

// Stands in for the bucket binding: one stored article, conditional reads and
// a record of the keys asked for.
function environment() {
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
    return key === "philosophy/articles/nietzsche.json";
  };
  return {
    keys,
    assets,
    ARTICLES: {
      async head(key) {
        return find(key) ? stored : null;
      },
      async get(key, options) {
        if (!find(key)) return null;
        return options.onlyIf.get("If-None-Match") === ETAG
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
  return worker.fetch(new Request(`https://app.example${path}`, init), env);
}

test("an article request returns that article with the crawl and security headers", async () => {
  const env = environment();
  const response = await ask(env, "/data/philosophy/articles/nietzsche.json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "nietzsche" });
  assert.deepEqual(env.keys, ["philosophy/articles/nietzsche.json"]);
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
  const response = await ask(env, "/data/philosophy/articles/nietzsche.json", {
    headers: { "If-None-Match": ETAG },
  });
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("ETag"), ETAG);
});

test("HEAD answers without a body and other methods are refused", async () => {
  const env = environment();
  const head = await ask(env, "/data/philosophy/articles/nietzsche.json", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await ask(env, "/data/philosophy/articles/nietzsche.json", {
    method: "POST",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
  assert.deepEqual(env.keys, ["philosophy/articles/nietzsche.json"]);
});

test("a missing article is a 404 with the crawl header", async () => {
  const env = environment();
  const response = await ask(env, "/data/philosophy/articles/absent.json");
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
    "/data/philosophy/graph.json",
    "/data/philosophy/articles/",
    "/data/philosophy/articles/a/b.json",
    "/data/philosophy/articles/..%2Fgraph.json",
    "/data/Philosophy/articles/nietzsche.json",
    "/data/philosophy/articles/nietzsche.json.bak",
  ];
  for (const path of paths) assert.equal((await ask(env, path)).status, 200);
  assert.deepEqual(env.keys, []);
  assert.equal(env.assets.length, paths.length);
});
