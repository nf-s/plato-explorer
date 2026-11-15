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

test("app staging contains the app and the realm list without realm data, account assets or deployment sources", async (t) => {
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
    "realm.js",
    "data/realms.json",
  ])
    assert.ok(names.includes(path), `Missing public asset: ${path}`);
  assert.deepEqual(
    names.filter((name) => name.startsWith("data/")),
    ["data/realms.json"],
  );
  assert.ok(
    names.every(
      (name) =>
        !/(?:^|\/)(?:\.|worker|functions|login|account|wrangler)/u.test(name),
    ),
  );
  const html = await readFile(new URL("index.html", staged), "utf8");
  assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/u);
  assert.doesNotMatch(html, /(?:login|account)\.(?:js|css)/u);
  const app = await readFile(new URL("app.js", staged), "utf8");
  assert.doesNotMatch(app, /initAccount|\/api\/session|\/auth\/google/u);
  // The released app reads each realm from its own address and may connect
  // only to those addresses.
  const realms = validateRealms(
    JSON.parse(await readFile(new URL("data/realms.json", staged), "utf8")),
  );
  const rules = await readFile(new URL("_headers", staged), "utf8");
  for (const realm of realms) {
    const address = new URL(realm.data);
    assert.equal(address.protocol, "https:");
    assert.ok(address.hostname.endsWith(`-${realm.id}.pages.dev`));
    assert.match(
      rules,
      new RegExp(`connect-src 'self'[^;]* ${address.origin}[ ;]`, "u"),
    );
  }
});

test("realm staging contains one realm's data with one file per article and no local reports", async (t) => {
  if (!(await built(t))) return;
  prepare("--realm", "philosophy");
  const staged = new URL(".artifacts/realms/philosophy/", root);
  const names = await readdir(staged, { recursive: true });
  for (const path of [
    "realm.json",
    "links.json",
    "graph.json",
    "articles/nietzsche.json",
    "search/manifest.json",
    "robots.txt",
    "_headers",
  ])
    assert.ok(names.includes(path), `Missing realm asset: ${path}`);
  assert.ok(names.length < 20000);
  assert.ok(
    names.every(
      (name) =>
        !/(?:^|\/)(?:\.|build-report|keyword-report|word-freq)/u.test(name),
    ),
  );
  const graph = JSON.parse(
    await readFile(new URL("graph.json", staged), "utf8"),
  );
  assert.equal(
    names.filter((name) => /^articles\/.+\.json$/u.test(name)).length,
    graph.nodes.filter((node) => node.article).length,
  );
  // Another origin reads these files, and crawlers are asked to stay out.
  const rules = await readFile(new URL("_headers", staged), "utf8");
  assert.match(rules, /^\/\*\n {2}Access-Control-Allow-Origin: \*$/mu);
  assert.match(
    rules,
    /^ {2}X-Robots-Tag: noindex, nofollow, noarchive, nosnippet$/mu,
  );
  assert.match(rules, /^ {2}X-Content-Type-Options: nosniff$/mu);
});
