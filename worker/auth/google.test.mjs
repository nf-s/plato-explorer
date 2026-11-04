import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  GoogleIdentityProvider,
  JWKS_ENDPOINT,
  TOKEN_ENDPOINT,
} from "./google.mjs";
import {
  AuthError,
  base64url,
  configFromEnv,
  randomToken,
  safeReturnUrl,
} from "./security.mjs";
import { ENV, NOW } from "./test-support.mjs";

let pair;
let jwk;
const config = configFromEnv(ENV);
const nonce = randomToken();
const validClaims = {
  iss: "https://accounts.google.com",
  aud: config.clientId,
  sub: "google-123",
  email: "admin@example.com",
  email_verified: true,
  hd: "example.com",
  iat: NOW,
  exp: NOW + 3600,
  nonce,
};

before(async () => {
  pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "key-1",
    alg: "RS256",
    use: "sig",
  };
});

async function signed(claims = validClaims, header = {}) {
  const encode = (value) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ alg: "RS256", kid: "key-1", typ: "JWT", ...header })}.${encode(claims)}`;
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body))))}`;
}

function verifier(
  fetcher = async () =>
    Response.json(
      { keys: [jwk] },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    ),
) {
  return new GoogleIdentityProvider(config, {
    fetcher,
    clock: () => NOW,
    keyCache: { keys: [], expiresAt: 0 },
  });
}

test("configuration fails closed without credentials and accepts only canonical HTTPS origins", () => {
  for (const name of Object.keys(ENV)) {
    const env = { ...ENV };
    delete env[name];
    assert.throws(
      () => configFromEnv(env),
      (error) => error.status === 503,
    );
  }
  for (const publicUrl of [
    "http://docs.example.com",
    "https://user:pass@docs.example.com",
    "https://docs.example.com/callback",
    "https://docs.example.com?x=1",
    "https://docs.example.com#x",
    "https://docs.example.com\n",
  ]) {
    assert.throws(
      () => configFromEnv({ ...ENV, PUBLIC_URL: publicUrl }),
      AuthError,
    );
  }
  assert.equal(
    configFromEnv({ ...ENV, PUBLIC_URL: "https://DOCS.example.com/" })
      .publicUrl,
    ENV.PUBLIC_URL,
  );
  assert.throws(() => configFromEnv({ ...ENV, ADMIN_SUBJECT: 123 }), AuthError);
});

test("return URLs reject external, encoded and authentication-loop redirects", () => {
  for (const target of [
    "https://evil.example",
    "//evil.example",
    "/\\evil",
    "/%2fevil",
    "/%252fevil",
    "/%5cevil",
    "/%0d%0aLocation:evil",
    "/auth/google/start",
    "javascript:alert(1)",
    "/%zz",
  ])
    assert.equal(safeReturnUrl(target), "/", target);
  assert.equal(
    safeReturnUrl("/?doc=manual%2Fkeyword_store#syntax"),
    "/?doc=manual%2Fkeyword_store#syntax",
  );
});

test("real RS256 signature and required claims produce a bounded Google identity", async () => {
  assert.deepEqual(await verifier().verifyIdToken(await signed(), nonce), {
    email: ENV.ADMIN_EMAIL,
    sub: "google-123",
    authoritativeEmail: true,
  });
  const gmail = { ...validClaims, email: "person@gmail.com" };
  delete gmail.hd;
  assert.equal(
    (await verifier().verifyIdToken(await signed(gmail), nonce))
      .authoritativeEmail,
    true,
  );
  const thirdParty = { ...gmail, email: "person@example.com" };
  assert.equal(
    (await verifier().verifyIdToken(await signed(thirdParty), nonce))
      .authoritativeEmail,
    false,
  );
});

test("forged or algorithm-confused JWTs cannot authenticate", async () => {
  const token = await signed();
  const [header, payload, signature] = token.split(".");
  const altered = base64url(
    new TextEncoder().encode(
      JSON.stringify({ ...validClaims, sub: "attacker" }),
    ),
  );
  for (const invalid of [
    `${header}.${altered}.${signature}`,
    `${header}.${payload}.AAAA`,
    "bad",
    await signed(validClaims, { alg: "HS256" }),
    await signed(validClaims, { alg: "none" }),
    await signed(validClaims, { crit: ["extra"] }),
  ]) {
    await assert.rejects(
      () => verifier().verifyIdToken(invalid, nonce),
      AuthError,
    );
  }
});

test("wrong issuer, audience, timestamps, nonce and malformed verified claims fail", async () => {
  const cases = [
    { iss: "https://evil.example" },
    { iss: [] },
    { aud: "other-client" },
    { aud: [config.clientId, "other-client"] },
    { azp: "other-client" },
    { iat: NOW + 61 },
    { iat: NOW - 1000 },
    { iat: true },
    { exp: NOW },
    { exp: "9999999999" },
    { nbf: NOW + 1 },
    { nonce: "wrong" },
    { nonce: null },
    { sub: "" },
    { sub: {} },
    { sub: "x".repeat(256) },
    { email_verified: false },
    { email_verified: "true" },
    { email_verified: 1 },
    { email: "missing-at" },
    { email: " user@example.com" },
    { hd: "" },
    { hd: {} },
  ];
  for (const changes of cases)
    await assert.rejects(
      () =>
        signed({ ...validClaims, ...changes }).then((token) =>
          verifier().verifyIdToken(token, nonce),
        ),
      AuthError,
      JSON.stringify(changes),
    );
});

test("JWKS caches honor expiry and refresh on an unknown key ID", async () => {
  let calls = 0;
  let now = NOW;
  const provider = new GoogleIdentityProvider(config, {
    clock: () => now,
    keyCache: { keys: [], expiresAt: 0 },
    fetcher: async (url) => {
      assert.equal(url, JWKS_ENDPOINT);
      calls += 1;
      return Response.json(
        { keys: [{ ...jwk, kid: calls === 3 ? "key-2" : "key-1" }] },
        { headers: { "Cache-Control": "max-age=60" } },
      );
    },
  });
  await provider.verifyIdToken(await signed(), nonce);
  await provider.verifyIdToken(await signed(), nonce);
  assert.equal(calls, 1);
  now += 61;
  await provider.verifyIdToken(await signed(), nonce);
  assert.equal(calls, 2);
  await provider.verifyIdToken(
    await signed(validClaims, { kid: "key-2" }),
    nonce,
  );
  assert.equal(calls, 3);
});

test("fetch uses a Worker-compatible receiver and redirect policy", async () => {
  const provider = verifier(async function (url, options) {
    assert.equal(this, undefined);
    assert.equal(options.redirect, "manual");
    if (url === JWKS_ENDPOINT) return Response.json({ keys: [jwk] });
    return Response.json({
      id_token: await signed(),
      access_token: "access-secret",
      token_type: "Bearer",
    });
  });
  assert.equal(
    (await provider.exchange("code", "verifier", nonce)).email,
    ENV.ADMIN_EMAIL,
  );
});

test("code exchange pins endpoints, disables redirects and never returns Google tokens", async () => {
  const token = await signed();
  const provider = verifier(async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url === JWKS_ENDPOINT) return Response.json({ keys: [jwk] });
    assert.equal(url, TOKEN_ENDPOINT);
    assert.equal(options.method, "POST");
    assert.equal(options.body.get("code"), "authorization-code");
    assert.equal(options.body.get("code_verifier"), "verifier");
    assert.equal(options.body.get("client_secret"), ENV.GOOGLE_CLIENT_SECRET);
    assert.equal(
      options.body.get("redirect_uri"),
      `${ENV.PUBLIC_URL}/auth/google/callback`,
    );
    return Response.json({
      id_token: token,
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const identity = await provider.exchange(
    "authorization-code",
    "verifier",
    nonce,
  );
  assert.equal(JSON.stringify(identity).includes("secret"), false);
});

test("token and signing-key redirects are rejected without following them", async () => {
  await assert.rejects(
    async () =>
      verifier(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://other.example/" },
          }),
      ).exchange("code", "verifier", nonce),
    AuthError,
  );
  await assert.rejects(
    async () =>
      verifier(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://other.example/" },
          }),
      ).verifyIdToken(await signed(), nonce),
    AuthError,
  );
});

test("network errors and oversized or malformed token responses fail without secret disclosure", async () => {
  const fetchers = [
    async () => {
      throw new Error("private-client-secret");
    },
    async () =>
      Response.json({ error: "private-provider-error" }, { status: 400 }),
    async () => new Response("<html>private-provider-error</html>"),
    async () => Response.json({ text: "x".repeat(70000) }),
    async () =>
      Response.json({
        id_token: await signed(),
        access_token: "a",
        token_type: "Bearer",
        expires_in: "3600",
      }),
  ];
  for (const fetcher of fetchers)
    await assert.rejects(
      () => verifier(fetcher).exchange("code", "verifier", nonce),
      (error) =>
        error instanceof AuthError && !error.message.includes("private-"),
    );
});
