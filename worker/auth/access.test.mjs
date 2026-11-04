import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAuthRequest, requireAccess, COOKIE_NAMES } from "./index.mjs";
import {
  AuthError,
  EnrollmentRequired,
  base64url,
  hash,
  randomToken,
} from "./security.mjs";
import { ENV, NOW, LocalD1, harness } from "./test-support.mjs";

const opened = [];
function setup(env = ENV, binding) {
  const value = harness(env, binding);
  opened.push(value.binding);
  return value;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const viewer = {
  email: "friend@gmail.com",
  sub: "friend-456",
  authoritativeEmail: true,
};

function request(
  path,
  {
    method = "GET",
    session,
    csrf,
    origin,
    body,
    cookieHeader,
    extra = {},
  } = {},
) {
  const headers = new Headers(extra);
  if (session)
    headers.set(
      "Cookie",
      `${COOKIE_NAMES.session}=${session.sessionToken}; ${COOKIE_NAMES.csrf}=${session.csrfToken}`,
    );
  if (cookieHeader !== undefined) headers.set("Cookie", cookieHeader);
  if (csrf !== undefined) headers.set("X-CSRF-Token", csrf);
  if (origin !== undefined) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${ENV.PUBLIC_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("login creates S256 PKCE and browser-bound state, then consumes it exactly once", async () => {
  const h = setup();
  h.provider.identity = {
    email: ENV.ADMIN_EMAIL,
    sub: "admin-123",
    authoritativeEmail: true,
  };
  const start = await h.auth.beginLogin("/?doc=manual%2Fkeyword_store");
  const params = new URL(start.authorizationUrl).searchParams;
  assert.equal(params.get("scope"), "openid email");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.has("client_secret"), false);
  const callback = {
    code: "server-code",
    state: params.get("state"),
    browserToken: start.browserToken,
  };
  await assert.rejects(
    () => h.auth.finishLogin({ ...callback, browserToken: randomToken() }),
    AuthError,
  );
  assert.equal(h.provider.calls.length, 0);
  const login = await h.auth.finishLogin(callback);
  const sent = h.provider.calls[0];
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(sent.verifier),
      ),
    ),
  );
  assert.equal(challenge, params.get("code_challenge"));
  assert.equal(sent.nonce, params.get("nonce"));
  assert.equal(login.returnTo, "/?doc=manual%2Fkeyword_store");
  await assert.rejects(() => h.auth.finishLogin(callback), AuthError);
  assert.equal(h.provider.calls.length, 1);
});

test("expired and cancelled flows do not exchange codes", async () => {
  const h = setup();
  const start = await h.auth.beginLogin();
  h.advance(600);
  await assert.rejects(
    () =>
      h.auth.finishLogin({
        code: "code",
        state: new URL(start.authorizationUrl).searchParams.get("state"),
        browserToken: start.browserToken,
      }),
    AuthError,
  );
  const next = await h.auth.beginLogin();
  const callback = {
    code: "code",
    state: new URL(next.authorizationUrl).searchParams.get("state"),
    browserToken: next.browserToken,
    error: "access_denied",
  };
  await assert.rejects(
    () => h.auth.finishLogin(callback),
    (error) => error.code === "login_cancelled",
  );
  await assert.rejects(
    () => h.auth.finishLogin({ ...callback, error: undefined }),
    (error) => error.code === "invalid_state",
  );
  assert.equal(h.provider.calls.length, 0);
});

test("a verified but ungranted identity is denied and cannot list grants", async () => {
  const h = setup();
  await assert.rejects(
    () => h.login(viewer),
    (error) => error.status === 403,
  );
  assert.equal(
    h.binding.database
      .prepare("SELECT count(*) AS count FROM access_grants")
      .get().count,
    0,
  );
  await assert.rejects(
    () => h.auth.listGrants(randomToken()),
    (error) => error.status === 401,
  );
});

test("admin bootstraps, grants an email, binds its subject and blocks rebinding", async () => {
  const h = setup();
  const admin = await h.login();
  assert.equal(admin.principal.isAdmin, true);
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    " Friend@Gmail.com ",
  );
  const friend = await h.login(viewer);
  assert.equal(friend.principal.isAdmin, false);
  assert.equal(
    (await h.auth.authenticate(friend.sessionToken)).principal.sub,
    viewer.sub,
  );
  await assert.rejects(
    () => h.login({ ...viewer, sub: "replacement-account" }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => h.auth.listGrants(friend.sessionToken),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () =>
      h.auth.grantEmail(
        friend.sessionToken,
        friend.csrfToken,
        ENV.PUBLIC_URL,
        "stranger@gmail.com",
      ),
    (error) => error.status === 403,
  );
});

test("custom-domain admin needs explicit subject enrollment unless Google hosts the account", async () => {
  const h = setup();
  const custom = {
    email: ENV.ADMIN_EMAIL,
    sub: "admin-custom",
    authoritativeEmail: false,
  };
  await assert.rejects(
    () => h.login(custom),
    (error) =>
      error instanceof EnrollmentRequired &&
      error.email === custom.email &&
      error.subject === custom.sub,
  );
  assert.equal(
    h.binding.database
      .prepare("SELECT count(*) AS count FROM access_sessions")
      .get().count,
    0,
  );
  const approved = setup({ ...ENV, ADMIN_SUBJECT: custom.sub });
  assert.equal((await approved.login(custom)).principal.isAdmin, true);
  await assert.rejects(
    () =>
      approved.login({
        ...custom,
        sub: "another-subject",
        authoritativeEmail: true,
      }),
    AuthError,
  );
});

test("non-authoritative viewer email needs an administrator-approved subject", async () => {
  const h = setup();
  const admin = await h.login();
  const custom = {
    email: "friend@example.com",
    sub: "custom-456",
    authoritativeEmail: false,
  };
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    custom.email,
  );
  await assert.rejects(() => h.login(custom), EnrollmentRequired);
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    custom.email,
    custom.sub,
  );
  assert.equal((await h.login(custom)).principal.sub, custom.sub);
});

test("revocation blocks every existing session and regrant preserves the subject binding", async () => {
  const h = setup();
  const admin = await h.login();
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  const one = await h.login(viewer);
  const two = await h.login(viewer);
  await h.auth.revokeEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  assert.equal(await h.auth.authenticate(one.sessionToken), null);
  assert.equal(await h.auth.authenticate(two.sessionToken), null);
  await assert.rejects(() => h.login(viewer), AuthError);
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  await assert.rejects(
    () => h.login({ ...viewer, sub: "different-subject" }),
    AuthError,
  );
  const replacement = await h.login(viewer);
  assert.ok(await h.auth.authenticate(replacement.sessionToken));
});

test("explicit rebind revokes old sessions and accepts only the new approved subject", async () => {
  const h = setup();
  const admin = await h.login();
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  const prior = await h.login(viewer);
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
    "new-subject",
  );
  assert.equal(await h.auth.authenticate(prior.sessionToken), null);
  await assert.rejects(() => h.login(viewer), AuthError);
  assert.equal(
    (await h.login({ ...viewer, sub: "new-subject" })).principal.sub,
    "new-subject",
  );
});

test("CSRF and exact-origin checks protect grants, revokes and logout", async () => {
  const h = setup();
  const admin = await h.login();
  for (const [csrf, origin] of [
    [undefined, ENV.PUBLIC_URL],
    [randomToken(), ENV.PUBLIC_URL],
    [admin.csrfToken, "https://evil.example"],
    [admin.csrfToken, null],
  ]) {
    await assert.rejects(
      () => h.auth.grantEmail(admin.sessionToken, csrf, origin, viewer.email),
      (error) => error.code === "csrf_failed",
    );
    await assert.rejects(
      () => h.auth.logout(admin.sessionToken, csrf, origin),
      (error) => error.code === "csrf_failed",
    );
  }
  await assert.rejects(
    () =>
      h.auth.revokeEmail(
        admin.sessionToken,
        admin.csrfToken,
        ENV.PUBLIC_URL,
        ENV.ADMIN_EMAIL,
      ),
    (error) => error.code === "managed_admin",
  );
  await h.auth.logout(admin.sessionToken, admin.csrfToken, ENV.PUBLIC_URL);
  assert.equal(await h.auth.authenticate(admin.sessionToken), null);
});

test("session and CSRF secrets are hashed in the database and sessions expire", async () => {
  const h = setup();
  const admin = await h.login();
  const session = h.binding.database
    .prepare("SELECT * FROM access_sessions")
    .get();
  assert.equal(session.token_hash, await hash(admin.sessionToken));
  assert.equal(session.csrf_hash, await hash(admin.csrfToken));
  assert.equal(JSON.stringify(session).includes(admin.sessionToken), false);
  h.advance(8 * 3600);
  assert.equal(await h.auth.authenticate(admin.sessionToken), null);
});

test("mutable access state survives reopening its separate database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ma3-access-"));
  const filename = join(directory, "access.sqlite");
  const first = harness(ENV, new LocalD1(filename));
  try {
    const admin = await first.login();
    await first.auth.grantEmail(
      admin.sessionToken,
      admin.csrfToken,
      ENV.PUBLIC_URL,
      viewer.email,
    );
    first.binding.close();
    const reopened = harness(ENV, new LocalD1(filename, false));
    try {
      assert.ok(await reopened.auth.authenticate(admin.sessionToken));
      assert.equal(
        (await reopened.auth.listGrants(admin.sessionToken)).find(
          (grant) => grant.email === viewer.email,
        ).enabled,
        true,
      );
    } finally {
      reopened.binding.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conditional session insertion rejects a grant revoked after the preliminary read", async () => {
  const h = setup();
  const admin = await h.login();
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  const original = h.binding.batch.bind(h.binding);
  h.binding.batch = async (statements) => {
    h.binding.database
      .prepare("UPDATE access_grants SET enabled=0 WHERE email=?")
      .run(viewer.email);
    return original(statements);
  };
  await assert.rejects(
    () =>
      h.store.createSession(viewer, "token-hash", "csrf-hash", NOW, NOW + 1000),
    (error) => error.status === 403,
  );
  assert.equal(
    h.binding.database
      .prepare("SELECT count(*) AS count FROM access_sessions WHERE email=?")
      .get(viewer.email).count,
    0,
  );
});

test("conditional administrator mutation rejects a session logged out after preliminary check", async () => {
  const h = setup();
  const admin = await h.login();
  const original = h.binding.batch.bind(h.binding);
  h.binding.batch = async (statements) => {
    h.binding.database.prepare("DELETE FROM access_sessions").run();
    return original(statements);
  };
  const actorHash = await hash(admin.sessionToken);
  await assert.rejects(
    () => h.store.grantEmail(actorHash, viewer.email, null, NOW),
    (error) => error.status === 403,
  );
  assert.equal(
    h.binding.database
      .prepare("SELECT count(*) AS count FROM access_grants WHERE email=?")
      .get(viewer.email).count,
    0,
  );
});

test("access-list reads also reject an administrator logged out after the preliminary check", async () => {
  const h = setup();
  const admin = await h.login();
  const original = h.store.administrator.bind(h.store);
  h.store.administrator = async (...args) => {
    const principal = await original(...args);
    h.binding.database.prepare("DELETE FROM access_sessions").run();
    return principal;
  };
  await assert.rejects(
    () => h.auth.listGrants(admin.sessionToken),
    (error) => error.status === 403,
  );
});

test("audit records cover login, access changes and logout without tokens", async () => {
  const h = setup();
  const admin = await h.login();
  await h.auth.grantEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  await h.auth.revokeEmail(
    admin.sessionToken,
    admin.csrfToken,
    ENV.PUBLIC_URL,
    viewer.email,
  );
  await h.auth.logout(admin.sessionToken, admin.csrfToken, ENV.PUBLIC_URL);
  const audit = h.binding.database
    .prepare("SELECT * FROM access_audit ORDER BY id")
    .all();
  assert.deepEqual(
    audit.map((row) => row.action),
    ["login", "grant", "revoke", "logout"],
  );
  assert.equal(JSON.stringify(audit).includes(admin.sessionToken), false);
  assert.equal(JSON.stringify(audit).includes(admin.csrfToken), false);
});

test("database errors remain closed and disclose no database details", async () => {
  const h = setup();
  const admin = await h.login();
  h.binding.database.exec("DROP TABLE access_sessions");
  await assert.rejects(
    () => h.auth.authenticate(admin.sessionToken),
    (error) =>
      error.status === 503 && !error.message.includes("access_sessions"),
  );
  const result = await requireAccess(
    request("/assets/private.png", { session: admin }),
    h.env,
    h.dependencies,
  );
  assert.equal(result.response.status, 503);
});

test("HTTP gates deny cookies missing, duplicated, malformed and Basic fallback", async () => {
  const h = setup();
  const admin = await h.login();
  for (const path of [
    "/",
    "/api/search?q=test",
    "/content/manual/sample.md",
    "/release-notes-pdf/sample.pdf",
    "/assets/image.png",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const denied = await requireAccess(
        request(path, {
          method,
          extra: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        h.env,
        h.dependencies,
      );
      assert.equal(denied.response.status, 401);
      const allowed = await requireAccess(
        request(path, { method, session: admin }),
        h.env,
        h.dependencies,
      );
      assert.equal(allowed.response, null);
      assert.equal(allowed.principal.email, ENV.ADMIN_EMAIL);
    }
  }
  const duplicate = `${COOKIE_NAMES.session}=${admin.sessionToken}; ${COOKIE_NAMES.session}=${admin.sessionToken}`;
  assert.equal(
    (
      await requireAccess(
        request("/", { cookieHeader: duplicate }),
        h.env,
        h.dependencies,
      )
    ).response.status,
    400,
  );
  assert.equal(
    (
      await requireAccess(
        request("/", { cookieHeader: `${COOKIE_NAMES.session}=bad` }),
        h.env,
        h.dependencies,
      )
    ).response.status,
    400,
  );
  assert.equal((await requireAccess(request("/"), {})).response.status, 503);
});

test("HTTP contract provides session/admin data, enforces mutations and clears logout cookies", async () => {
  const h = setup();
  const route = (req) => handleAuthRequest(req, h.env, h.dependencies);
  assert.deepEqual(await (await route(request("/api/session"))).json(), {
    authenticated: false,
  });
  const admin = await h.login();
  const sessionResponse = await route(
    request("/api/session", { session: admin }),
  );
  const session = await sessionResponse.json();
  assert.equal(session.isAdmin, true);
  assert.equal(session.csrfToken, admin.csrfToken);
  assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
  const mutation = {
    method: "POST",
    session: admin,
    csrf: admin.csrfToken,
    origin: ENV.PUBLIC_URL,
    body: { email: viewer.email },
  };
  assert.equal(
    (await route(request("/api/admin/access", mutation))).status,
    200,
  );
  const list = await (
    await route(request("/api/admin/access", { session: admin }))
  ).json();
  assert.equal(list.adminEmail, ENV.ADMIN_EMAIL);
  assert.equal(
    list.grants.find((grant) => grant.email === viewer.email).enabled,
    true,
  );
  assert.equal(
    (
      await route(
        request("/api/admin/access", {
          ...mutation,
          body: { email: viewer.email, role: "admin" },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await route(request("/api/admin/access", { ...mutation, csrf: "bad" })))
      .status,
    403,
  );
  assert.equal((await route(request("/auth/logout"))).status, 405);
  const loggedOut = await route(
    request("/auth/logout", {
      method: "POST",
      session: admin,
      csrf: admin.csrfToken,
      origin: ENV.PUBLIC_URL,
    }),
  );
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.headers.getSetCookie().length, 4);
  assert.ok(
    loggedOut.headers
      .getSetCookie()
      .every(
        (value) => value.includes("Max-Age=0") && value.includes("Secure"),
      ),
  );
});

test("HTTP login callback uses secure cookies, rejects duplicate parameters and never accepts browser ID tokens", async () => {
  const h = setup();
  const route = (req) => handleAuthRequest(req, h.env, h.dependencies);
  h.provider.identity = {
    email: ENV.ADMIN_EMAIL,
    sub: "admin-123",
    authoritativeEmail: true,
  };
  const start = await route(
    request("/auth/google/start?next=%2F%2Fevil.example"),
  );
  const loginCookie = start.headers.getSetCookie()[0];
  assert.ok(
    loginCookie.includes("HttpOnly") &&
      loginCookie.includes("Secure") &&
      loginCookie.includes("SameSite=Lax") &&
      !loginCookie.includes("Domain="),
  );
  const authUrl = new URL(start.headers.get("location"));
  const state = authUrl.searchParams.get("state");
  const browserCookie = loginCookie.split(";")[0];
  const invalid = await route(
    request(`/auth/google/callback?code=one&code=two&state=${state}`, {
      cookieHeader: browserCookie,
    }),
  );
  assert.equal(invalid.status, 303);
  assert.equal(invalid.headers.get("location"), "/login?error=invalid_request");
  const completed = await route(
    request(`/auth/google/callback?code=valid-code&state=${state}`, {
      cookieHeader: browserCookie,
    }),
  );
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get("location"), "/");
  assert.equal(completed.headers.getSetCookie().length, 4);
  assert.equal(
    (await route(request("/auth/google/callback?id_token=forged"))).status,
    303,
  );
  assert.equal(await route(request("/ordinary-route")), null);
});

test("enrollment redirects expose verified identity only to the bound browser, never in URLs", async () => {
  const h = setup();
  const route = (req) => handleAuthRequest(req, h.env, h.dependencies);
  h.provider.identity = {
    email: ENV.ADMIN_EMAIL,
    sub: "custom-admin-subject",
    authoritativeEmail: false,
  };
  const start = await route(request("/auth/google/start"));
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  const callback = await route(
    request(`/auth/google/callback?code=private-code&state=${state}`, {
      cookieHeader: start.headers.getSetCookie()[0].split(";")[0],
    }),
  );
  assert.equal(callback.status, 303);
  assert.equal(
    callback.headers.get("location"),
    "/login?error=enrollment_required",
  );
  const enrollmentCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE_NAMES.enrollment}=`));
  assert.ok(
    enrollmentCookie.includes("HttpOnly") &&
      enrollmentCookie.includes("Secure"),
  );
  const boundRequest = request("/api/enrollment", {
    cookieHeader: enrollmentCookie.split(";")[0],
  });
  const enrollment = await (await route(boundRequest)).json();
  assert.equal(enrollment.enrollment.email, ENV.ADMIN_EMAIL);
  assert.equal(enrollment.enrollment.subject, "custom-admin-subject");
  assert.deepEqual(await (await route(request("/api/enrollment"))).json(), {
    enrollment: null,
  });
  assert.equal(
    (await requireAccess(boundRequest, h.env, h.dependencies)).response.status,
    401,
  );
  h.advance(600);
  assert.deepEqual(await (await route(boundRequest)).json(), {
    enrollment: null,
  });
});
