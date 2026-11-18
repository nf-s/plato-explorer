import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSessionMarker,
  loadSession,
  signInFailure,
  signInHref,
  validateEnrollment,
  validateGrants,
  validateSession,
  withoutSignInFailure,
} from "../web/account.js";
import { COOKIE_NAMES } from "../worker/auth/index.mjs";
import { safeReturnUrl } from "../worker/auth/security.mjs";

const SITE = { hostname: "app.example" };
const MARKER = `${COOKIE_NAMES.csrf}=token`;
const SESSION = {
  authenticated: true,
  email: "reader@example.com",
  sub: "reader-1",
  isAdmin: false,
  csrfToken: "token",
  expiresAt: 1800000000,
};

function service(status, body) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, request };
}

test("a visitor without the session marker makes no account request", async () => {
  const { calls, request } = service(200, SESSION);
  assert.deepEqual(await loadSession(SITE, "", request), { kind: "anonymous" });
  assert.deepEqual(await loadSession(SITE, "theme=dark; other=1", request), {
    kind: "anonymous",
  });
  assert.deepEqual(calls, []);
  // The marker is the cookie the account service sets with every session.
  assert.ok(hasSessionMarker(`theme=dark; ${MARKER}`));
  assert.ok(!hasSessionMarker(`x${MARKER}`));
});

test("the local preview has no account service", async () => {
  const { calls, request } = service(200, SESSION);
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"])
    assert.deepEqual(await loadSession({ hostname }, MARKER, request), {
      kind: "local",
    });
  assert.deepEqual(calls, []);
});

test("a browser with the marker asks for its session", async () => {
  const signedIn = service(200, SESSION);
  assert.deepEqual(await loadSession(SITE, MARKER, signedIn.request), {
    kind: "signed-in",
    email: "reader@example.com",
    isAdmin: false,
    csrfToken: "token",
  });
  assert.deepEqual(signedIn.calls, ["/api/session"]);
  const expired = service(200, { authenticated: false });
  assert.deepEqual(await loadSession(SITE, MARKER, expired.request), {
    kind: "anonymous",
  });
});

test("an account service that fails or answers badly leaves the public app working", async () => {
  for (const { request } of [
    service(503, { error: "storage_unavailable" }),
    service(200, { authenticated: true }),
    service(200, "not a session"),
  ])
    assert.deepEqual(await loadSession(SITE, MARKER, request), {
      kind: "unavailable",
    });
  const offline = async () => {
    throw new TypeError("offline");
  };
  assert.deepEqual(await loadSession(SITE, MARKER, offline), {
    kind: "unavailable",
  });
});

test("sessions, access lists and approval details are validated", () => {
  for (const change of [
    { email: "" },
    { email: 1 },
    { isAdmin: "yes" },
    { csrfToken: "" },
    { csrfToken: 1 },
    { authenticated: "true" },
  ])
    assert.throws(
      () => validateSession({ ...SESSION, ...change }),
      /invalid response/u,
    );
  assert.equal(
    validateSession({ ...SESSION, csrfToken: null }).csrfToken,
    null,
  );
  const grant = {
    email: "reader@example.com",
    subject: null,
    enabled: true,
    isAdmin: false,
    updatedAt: 1,
  };
  assert.deepEqual(validateGrants({ adminEmail: "a@b.c", grants: [grant] }), [
    { email: "reader@example.com", enabled: true, isAdmin: false },
  ]);
  for (const data of [
    {},
    { grants: [{ ...grant, enabled: 1 }] },
    { grants: [null] },
  ])
    assert.throws(() => validateGrants(data), /invalid response/u);
  const details = {
    email: "reader@example.org",
    subject: "subject-1",
    expiresAt: 2000,
  };
  assert.deepEqual(validateEnrollment({ enrollment: details }, 1000), {
    email: "reader@example.org",
    subject: "subject-1",
  });
  assert.equal(validateEnrollment({ enrollment: details }, 2000001), null);
  assert.equal(validateEnrollment({ enrollment: null }, 1000), null);
  assert.throws(
    () => validateEnrollment({ enrollment: { ...details, subject: "" } }, 1),
    /could not be verified/u,
  );
});

test("a failed sign-in is explained once and leaves the address", () => {
  assert.equal(signInFailure("?realm=psychology"), null);
  assert.match(
    signInFailure("?signin=access_denied").message,
    /does not have access/u,
  );
  assert.equal(
    signInFailure("?signin=enrollment_required").code,
    "enrollment_required",
  );
  assert.equal(
    signInFailure("?signin=<script>").message,
    "Sign-in could not be completed. Try again.",
  );
  assert.equal(withoutSignInFailure("?signin=access_denied"), "");
  assert.equal(
    withoutSignInFailure("?realm=psychology&signin=access_denied"),
    "?realm=psychology",
  );
});

test("signing in returns to the page it started from", () => {
  const address = {
    pathname: "/",
    search: "?realm=philosophy&signin=invalid_state",
    hash: "#/nietzsche",
  };
  const href = signInHref(address);
  const next = new URL(href, "https://app.example").searchParams.get("next");
  assert.equal(next, "/?realm=philosophy#/nietzsche");
  assert.ok(href.startsWith("/auth/google/start?"));
  // The account service accepts the address as a place to return to.
  assert.equal(safeReturnUrl(next), next);
});
