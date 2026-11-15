import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateRealms } from "../web/realm.js";

const root = new URL("../", import.meta.url);

test("crawler exclusions cover the entire public site and all data responses", async () => {
  const robots = await readFile(new URL("web/robots.txt", root), "utf8");
  assert.match(robots, /^User-agent: \*\s+Disallow: \/\s*$/u);
  const rules = await readFile(new URL("web/_headers", root), "utf8");
  const [pattern, ...lines] = rules.trim().split("\n");
  assert.equal(pattern, "/*");
  assert.ok(lines.every((line) => /^ {2}\S/u.test(line)));
  const headers = new Headers(
    lines.map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
  assert.equal(
    headers.get("X-Robots-Tag"),
    "noindex, nofollow, noarchive, nosnippet",
  );
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  const policy = headers.get("Content-Security-Policy");
  assert.match(
    policy,
    /(?:^|; )script-src 'self' https:\/\/static\.cloudflareinsights\.com(?:;|$)/u,
  );
  assert.match(
    policy,
    /(?:^|; )connect-src 'self' https:\/\/cloudflareinsights\.com(?:;|$)/u,
  );
  assert.match(policy, /(?:^|; )frame-ancestors 'none'(?:;|$)/u);
});

function prepare(...options) {
  const result = spawnSync(
    "python3",
    ["scripts/deploy_public.py", "--prepare-only", ...options],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

async function built(t) {
  try {
    await access(new URL("web/data/philosophy/search/manifest.json", root));
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("Build the dataset and full-text index first.");
    return false;
  }
}

test("app staging contains the app and each realm's data without articles, reports, account assets or deployment sources", async (t) => {
  if (!(await built(t))) return;
  prepare();
  const staged = new URL(".artifacts/public/", root);
  const names = await readdir(staged, { recursive: true });
  for (const path of [
    "index.html",
    "app.js",
    "navigation.js",
    "article-preview.js",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/apple-touch-icon.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "robots.txt",
    "_headers",
    "_worker.js",
    "_routes.json",
    "realm.js",
    "data/realms.json",
  ])
    assert.ok(names.includes(path), `Missing public asset: ${path}`);
  assert.ok(names.length < 20000);
  assert.ok(
    names.every(
      (name) =>
        !/(?:^|\/)(?:\.|worker|functions|login|account|wrangler|articles|build-report|keyword-report|word-freq)/u.test(
          name,
        ),
    ),
  );
  const html = await readFile(new URL("index.html", staged), "utf8");
  assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/u);
  assert.doesNotMatch(html, /(?:login|account)\.(?:js|css)/u);
  const app = await readFile(new URL("app.js", staged), "utf8");
  assert.doesNotMatch(app, /initAccount|\/api\/session|\/auth\/google/u);
  const realms = validateRealms(
    JSON.parse(await readFile(new URL("data/realms.json", staged), "utf8")),
  );
  for (const realm of realms)
    for (const path of [
      "realm.json",
      "links.json",
      "graph.json",
      "search/manifest.json",
    ])
      assert.ok(
        names.includes(`data/${realm.id}/${path}`),
        `Missing ${realm.id} asset: ${path}`,
      );
  // Articles are served from object storage, and only their requests may
  // invoke the Function.
  const routes = JSON.parse(
    await readFile(new URL("_routes.json", staged), "utf8"),
  );
  assert.deepEqual(routes, {
    version: 1,
    include: realms.map((realm) => `/data/${realm.id}/articles/*`),
    exclude: [],
  });
});
