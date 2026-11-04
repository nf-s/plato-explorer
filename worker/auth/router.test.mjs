import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import worker from "../index.mjs";
import { COOKIE_NAMES } from "./index.mjs";
import { JWKS_ENDPOINT, TOKEN_ENDPOINT } from "./google.mjs";
import { base64url } from "./security.mjs";
import { ENV, NOW, harness } from "./test-support.mjs";

const opened = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function setup() {
  const h = harness();
  opened.push(h.binding);
  h.advance(Math.floor(Date.now() / 1000) - NOW);
  const assets = [];
  const env = {
    ...h.env,
    ASSETS: {
      async fetch(request) {
        assets.push(new URL(request.url).pathname);
        return new Response("asset body", {
          headers: {
            "Cache-Control": "public, max-age=86400",
            "Content-Type": "text/html",
          },
        });
      },
    },
  };
  return { ...h, env, assets };
}

function request(path, { method = "GET", cookie, headers = {} } = {}) {
  return new Request(`${ENV.PUBLIC_URL}${path}`, {
    method,
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

function assertPrivateHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
}

test("outer router gates private GET and HEAD before reading assets or corpus", async () => {
  const h = setup();
  for (const method of ["GET", "HEAD"]) {
    for (const path of [
      "/index.html",
      "/app.js",
      "/data/articles/nietzsche.json",
      "/data/graph.json",
      "/data/build-report.json",
      "/data/search/manifest.json",
      "/data/search/index.json",
      "/styles.css",
      "/account.js",
      "/api/search?q=Nietzsche",
      "/data%2fgraph.json",
      "/%64ata/articles/nietzsche.json",
      "/%61pp.js",
    ]) {
      const result = await worker.fetch(request(path, { method }), h.env);
      assert.equal(result.status, 401, `${method} ${path}`);
      assertPrivateHeaders(result);
      if (method === "HEAD") assert.equal(await result.text(), "");
    }
  }
  assert.deepEqual(h.assets, []);
  const root = await worker.fetch(request("/?article=nietzsche"), h.env);
  assert.equal(root.status, 303);
  assert.equal(
    root.headers.get("location"),
    "/login?next=%2F%3Farticle%3Dnietzsche",
  );
  const basic = await worker.fetch(
    request("/index.html", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    }),
    h.env,
  );
  assert.equal(basic.status, 401);
});

test("only the exact public login assets are served while configuration is absent", async () => {
  const h = setup();
  delete h.env.GOOGLE_CLIENT_SECRET;
  for (const path of ["/login", "/login.html", "/login.js", "/login.css"]) {
    const result = await worker.fetch(request(path), h.env);
    assert.equal(result.status, 200);
    assertPrivateHeaders(result);
  }
  assert.deepEqual(h.assets, [
    "/login.html",
    "/login.html",
    "/login.js",
    "/login.css",
  ]);
  for (const path of [
    "/login.js/private",
    "/login.html%2f..%2findex.html",
    "/index.html",
    "/api/search",
  ]) {
    const result = await worker.fetch(request(path), h.env);
    assert.ok([400, 503].includes(result.status), path);
  }
  assert.equal(h.assets.length, 4);
});

test("authenticated assets stay private and revocation immediately closes the outer gate", async () => {
  const h = setup();
  const admin = await h.login();
  const identity = {
    email: "viewer@gmail.com",
    sub: "viewer-123",
    authoritativeEmail: true,
  };
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    identity.email,
  );
  const viewer = await h.login(identity);
  const cookie = `${COOKIE_NAMES.session}=${viewer.sessionToken}; ${COOKIE_NAMES.csrf}=${viewer.csrfToken}`;
  const result = await worker.fetch(
    request("/data/articles/nietzsche.json", { cookie }),
    h.env,
  );
  assert.equal(result.status, 200);
  assertPrivateHeaders(result);
  const head = await worker.fetch(
    request("/", { method: "HEAD", cookie }),
    h.env,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  await h.auth.revokeEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    identity.email,
  );
  assert.equal(
    (
      await worker.fetch(
        request("/data/articles/nietzsche.json", { cookie }),
        h.env,
      )
    ).status,
    401,
  );
  assert.deepEqual(h.assets, ["/data/articles/nietzsche.json", "/index.html"]);
});

test("outer headers preserve all OAuth cookies through a signed callback and safe failure redirect", async () => {
  const h = setup();
  const started = await worker.fetch(
    request("/auth/google/start?next=%2F%3Fview%3Dcommands"),
    h.env,
  );
  assert.equal(started.status, 303);
  const params = new URL(started.headers.get("location")).searchParams;
  const bindingCookie = started.headers.getSetCookie()[0].split(";")[0];
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "router-key",
    alg: "RS256",
    use: "sig",
  };
  const encode = (value) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode({ iss: "https://accounts.google.com", aud: ENV.GOOGLE_CLIENT_ID, sub: "admin-123", email: ENV.ADMIN_EMAIL, email_verified: true, hd: "example.com", nonce: params.get("nonce"), iat: h.clock(), exp: h.clock() + 3600 })}`;
  const idToken = `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body))))}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === JWKS_ENDPOINT) return Response.json({ keys: [jwk] });
    assert.equal(url, TOKEN_ENDPOINT);
    return Response.json({
      token_type: "Bearer",
      access_token: "discarded-access-token",
      id_token: idToken,
    });
  };
  try {
    const callback = `/auth/google/callback?code=secret-code&state=${params.get("state")}`;
    const completed = await worker.fetch(
      request(callback, { cookie: bindingCookie }),
      h.env,
    );
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get("location"), "/?view=commands");
    assertPrivateHeaders(completed);
    const cookies = completed.headers.getSetCookie();
    assert.equal(cookies.length, 4);
    for (const value of cookies)
      assert.match(value, /Path=\/; Max-Age=\d+; Secure; SameSite=Lax/);
    assert.ok(
      cookies
        .find((value) => value.startsWith(`${COOKIE_NAMES.session}=`))
        .includes("HttpOnly"),
    );
    assert.ok(
      !cookies
        .find((value) => value.startsWith(`${COOKIE_NAMES.csrf}=`))
        .includes("HttpOnly"),
    );
    const repeated = await worker.fetch(
      request(callback, { cookie: bindingCookie }),
      h.env,
    );
    assert.equal(repeated.status, 303);
    assert.equal(
      repeated.headers.get("location"),
      "/login?error=invalid_state",
    );
    assert.equal(repeated.headers.getSetCookie().length, 2);
    assert.equal(await repeated.text(), "");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("encoded paths cannot extend the public login allowlist", async () => {
  const h = setup();
  for (const path of [
    "/login.html%2f..%2fdata/graph.json",
    "/login.js%00/data/graph.json",
    "/login.css%5c../data/graph.json",
    "/%ZZ",
  ]) {
    assert.equal((await worker.fetch(request(path), h.env)).status, 400, path);
  }
  for (const path of [
    "/login.js/private",
    "/login.html.json",
    "/login.css/",
    "/data//graph.json",
  ]) {
    assert.equal((await worker.fetch(request(path), h.env)).status, 401, path);
  }
  assert.deepEqual(h.assets, []);
});

test("deployment routes every asset through the private Worker gate", async () => {
  const local = new URL("../../wrangler.jsonc", import.meta.url);
  const example = new URL("../../wrangler.example.jsonc", import.meta.url);
  const raw = await readFile(existsSync(local) ? local : example, "utf8");
  const config = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
  assert.equal(config.main, "worker/index.mjs");
  assert.equal(config.assets.directory, "web");
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.html_handling, "none");
  assert.equal(config.assets.not_found_handling, "none");
  assert.equal(config.preview_urls, false);
  assert.equal(config.observability.logs.invocation_logs, false);
});
