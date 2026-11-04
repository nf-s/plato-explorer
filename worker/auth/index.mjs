import { GoogleIdentityProvider } from "./google.mjs";
import { OAuthService } from "./service.mjs";
import { D1AccessStore } from "./store.mjs";
import {
  AuthError,
  EnrollmentRequired,
  FLOW_SECONDS,
  SESSION_SECONDS,
  configFromEnv,
  equalSecret,
  hash,
  isOpaque,
  randomToken,
  readJson,
} from "./security.mjs";

export const COOKIE_NAMES = {
  session: "__Host-plato-session",
  csrf: "__Host-plato-csrf",
  login: "__Host-plato-login",
  enrollment: "__Host-plato-enrollment",
};

const ROUTES = new Map([
  ["/auth/google/start", ["GET"]],
  ["/auth/google/callback", ["GET"]],
  ["/auth/logout", ["POST"]],
  ["/api/session", ["GET"]],
  ["/api/enrollment", ["GET"]],
  ["/api/admin/access", ["GET", "POST", "DELETE"]],
]);

export function createAuthService(env, { store, provider, clock } = {}) {
  const config = configFromEnv(env);
  return new OAuthService(
    config,
    store || new D1AccessStore(env.AUTH_DB, config),
    provider || new GoogleIdentityProvider(config),
    clock,
  );
}

function cookies(request) {
  const value = request.headers.get("cookie") || "";
  if (value.length > 8192)
    throw new AuthError("Invalid authentication cookies.");
  const result = new Map();
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!Object.values(COOKIE_NAMES).includes(name)) continue;
    if (result.has(name))
      throw new AuthError("Duplicate authentication cookies.");
    const token = part.slice(index + 1).trim();
    if (!isOpaque(token))
      throw new AuthError("Invalid authentication cookies.");
    result.set(name, token);
  }
  return result;
}

function cookie(name, value, seconds, httpOnly = true) {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}`;
}

function response(value, status = 200, extra = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...extra,
  });
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers,
  });
}

function errorResponse(error) {
  if (error instanceof EnrollmentRequired)
    return response(
      {
        error: error.code,
        message: error.message,
        email: error.email,
        subject: error.subject,
      },
      error.status,
    );
  if (error instanceof AuthError)
    return response(
      { error: error.code, message: error.message },
      error.status,
    );
  return response(
    {
      error: "authentication_unavailable",
      message: "Authentication is temporarily unavailable.",
    },
    503,
  );
}

function parameter(url, name, required = true) {
  const values = url.searchParams.getAll(name);
  if (
    values.length > 1 ||
    (required && values.length !== 1) ||
    (values[0]?.length || 0) > 4096
  )
    throw new AuthError(`Invalid ${name} parameter.`);
  return values[0];
}

/** Public auth routes only. The caller must gate every other corpus route. */
export async function handleAuthRequest(request, env, dependencies = {}) {
  const url = new URL(request.url);
  const methods = ROUTES.get(url.pathname);
  if (!methods) return null;
  if (!methods.includes(request.method))
    return response(
      { error: "method_not_allowed", message: "Method not allowed." },
      405,
      { Allow: methods.join(", ") },
    );
  let auth;
  try {
    auth = createAuthService(env, dependencies);
    if (url.origin !== auth.config.publicUrl)
      throw new AuthError(
        "The request does not match the configured origin.",
        400,
      );
    const tokens = cookies(request);
    const sessionToken = tokens.get(COOKIE_NAMES.session);
    if (url.pathname === "/auth/google/start") {
      const started = await auth.beginLogin(
        parameter(url, "next", false) ?? "/",
      );
      const result = response(null, 303, {
        Location: started.authorizationUrl,
      });
      result.headers.append(
        "Set-Cookie",
        cookie(COOKIE_NAMES.login, started.browserToken, FLOW_SECONDS),
      );
      return result;
    }
    if (url.pathname === "/auth/google/callback") {
      const completed = await auth.finishLogin({
        code: parameter(url, "code", false),
        state: parameter(url, "state"),
        browserToken: tokens.get(COOKIE_NAMES.login),
        error: parameter(url, "error", false),
      });
      const result = response(null, 303, { Location: completed.returnTo });
      result.headers.append("Set-Cookie", cookie(COOKIE_NAMES.login, "", 0));
      result.headers.append(
        "Set-Cookie",
        cookie(COOKIE_NAMES.enrollment, "", 0),
      );
      result.headers.append(
        "Set-Cookie",
        cookie(COOKIE_NAMES.session, completed.sessionToken, SESSION_SECONDS),
      );
      result.headers.append(
        "Set-Cookie",
        cookie(COOKIE_NAMES.csrf, completed.csrfToken, SESSION_SECONDS, false),
      );
      return result;
    }
    if (url.pathname === "/api/session") {
      const session = await auth.authenticate(sessionToken);
      if (!session) return response({ authenticated: false });
      const csrf = tokens.get(COOKIE_NAMES.csrf);
      const csrfToken =
        isOpaque(csrf) && equalSecret(await hash(csrf), session.csrfHash)
          ? csrf
          : null;
      return response({
        authenticated: true,
        ...session.principal,
        csrfToken,
        expiresAt: session.expiresAt,
      });
    }
    if (url.pathname === "/api/enrollment") {
      const ticket = tokens.get(COOKIE_NAMES.enrollment);
      return response({
        enrollment: ticket
          ? await auth.store.getEnrollment(
              await hash(ticket),
              Math.floor(auth.clock()),
            )
          : null,
      });
    }
    if (url.pathname === "/auth/logout") {
      await auth.logout(
        sessionToken,
        request.headers.get("X-CSRF-Token"),
        request.headers.get("Origin"),
      );
      const result = response({ ok: true });
      for (const name of Object.values(COOKIE_NAMES))
        result.headers.append(
          "Set-Cookie",
          cookie(name, "", 0, name !== COOKIE_NAMES.csrf),
        );
      return result;
    }
    if (request.method === "GET")
      return response({
        adminEmail: auth.config.adminEmail,
        grants: await auth.listGrants(sessionToken),
      });
    const body = await readJson(request, 4096);
    const allowed =
      request.method === "POST" ? ["email", "subject"] : ["email"];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.email !== "string"
    )
      throw new AuthError("Invalid access request.");
    if (request.method === "POST") {
      await auth.grantEmail(
        sessionToken,
        request.headers.get("X-CSRF-Token"),
        request.headers.get("Origin"),
        body.email,
        body.subject ?? null,
      );
    } else {
      await auth.revokeEmail(
        sessionToken,
        request.headers.get("X-CSRF-Token"),
        request.headers.get("Origin"),
        body.email,
      );
    }
    return response({ ok: true });
  } catch (error) {
    if (url.pathname === "/auth/google/callback") {
      let failure = error;
      let enrollmentCookie = cookie(COOKIE_NAMES.enrollment, "", 0);
      if (error instanceof EnrollmentRequired && auth) {
        try {
          const token = randomToken();
          await auth.store.createEnrollment(
            await hash(token),
            error.email,
            error.subject,
            Math.floor(auth.clock()) + FLOW_SECONDS,
          );
          enrollmentCookie = cookie(
            COOKIE_NAMES.enrollment,
            token,
            FLOW_SECONDS,
          );
        } catch (storageError) {
          failure = storageError;
        }
      }
      const code =
        failure instanceof AuthError
          ? failure.code
          : "authentication_unavailable";
      const result = response(null, 303, {
        Location: `/login?error=${encodeURIComponent(code)}`,
      });
      result.headers.append("Set-Cookie", cookie(COOKIE_NAMES.login, "", 0));
      result.headers.append("Set-Cookie", enrollmentCookie);
      return result;
    }
    const result = errorResponse(error);
    return result;
  }
}

/** Deny by default. No Basic-auth or unsigned token fallback is accepted. */
export async function requireAccess(request, env, dependencies = {}) {
  try {
    const auth = createAuthService(env, dependencies);
    if (new URL(request.url).origin !== auth.config.publicUrl)
      throw new AuthError("The request does not match the configured origin.");
    const session = await auth.authenticate(
      cookies(request).get(COOKIE_NAMES.session),
    );
    if (!session)
      return {
        principal: null,
        response: response(
          {
            error: "authentication_required",
            message: "Authentication is required.",
          },
          401,
        ),
      };
    return { principal: session.principal, response: null };
  } catch (error) {
    return { principal: null, response: errorResponse(error) };
  }
}
