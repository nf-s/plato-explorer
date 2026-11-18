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

test("app staging contains the app and each public realm's data without articles, reports, restricted realms or deployment sources", async (t) => {
  if (!(await built(t))) return;
  prepare();
  const staged = new URL(".artifacts/public/", root);
  const names = await readdir(staged, { recursive: true });
  const app = JSON.parse(
    await readFile(new URL("realms/app.json", root), "utf8"),
  );
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
    "account.js",
    "data/realms.json",
  ])
    assert.ok(names.includes(path), `Missing public asset: ${path}`);
  assert.ok(names.length < 20000);
  assert.ok(
    names.every(
      (name) =>
        !/(?:^|\/)(?:\.|worker|functions|login|wrangler|articles|build-report|keyword-report|word-freq)/u.test(
          name,
        ),
    ),
  );
  const html = await readFile(new URL("index.html", staged), "utf8");
  assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/u);
  assert.doesNotMatch(html, /login\.(?:js|css)/u);
  const realms = validateRealms(
    JSON.parse(await readFile(new URL("data/realms.json", staged), "utf8")),
  );
  // A restricted realm is absent from the assets: no files, no menu entry and
  // no links to it from the public realms.
  assert.ok(app.restrictedRealms.length > 0);
  assert.deepEqual(
    realms.map((realm) => realm.id),
    app.realms.filter((id) => !app.restrictedRealms.includes(id)),
  );
  for (const id of app.restrictedRealms) {
    assert.ok(names.every((name) => !name.startsWith(`data/${id}/`)));
    for (const realm of realms) {
      const links = JSON.parse(
        await readFile(new URL(`data/${realm.id}/links.json`, staged), "utf8"),
      );
      assert.ok(!Object.hasOwn(links, id), `${realm.id} links to ${id}`);
    }
  }
  assert.ok(realms.every((realm) => !realm.restricted));
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
  // Only sign-in, a public realm's articles and everything in a restricted
  // realm may invoke the Function.
  const routes = JSON.parse(
    await readFile(new URL("_routes.json", staged), "utf8"),
  );
  assert.deepEqual(routes, {
    version: 1,
    include: [
      "/api/*",
      "/auth/*",
      ...realms.map((realm) => `/data/${realm.id}/articles/*`),
      ...app.restrictedRealms.map((id) => `/data/${id}/*`),
    ],
    exclude: [],
  });
  // The Function's sign-in service is staged beside the release, where its
  // import resolves, and is not uploaded as an asset.
  const worker = await readFile(new URL("_worker.js", staged), "utf8");
  for (const [, path] of worker.matchAll(/from "(\.\.\/[^"]+)"/gu))
    await access(new URL(path, new URL("_worker.js", staged)));
});
