import {
  AuthError,
  FLOW_SECONDS,
  decodeBase64url,
  equalSecret,
  normalizeEmail,
  readJson,
  validSubject,
} from "./security.mjs";

export const AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const sharedKeys = { keys: [], expiresAt: 0 };

function tokenObject(segment) {
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64url(segment),
      ),
    );
  } catch {
    throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
  return value;
}

export class GoogleIdentityProvider {
  constructor(
    config,
    {
      fetcher = fetch,
      clock = () => Date.now() / 1000,
      keyCache = sharedKeys,
    } = {},
  ) {
    this.config = config;
    this.fetcher = (...args) => fetcher(...args);
    this.clock = clock;
    this.keyCache = keyCache;
  }

  async exchange(code, verifier, nonce) {
    const body = new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });
    let response;
    try {
      response = await this.fetcher(TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
    } catch {
      throw new AuthError(
        "Google login could not be completed. Start a new login.",
        502,
        "google_unavailable",
      );
    }
    if (
      response.status !== 200 ||
      (response.url && response.url !== TOKEN_ENDPOINT)
    )
      throw new AuthError(
        "Google rejected the login exchange.",
        401,
        "invalid_identity",
      );
    const result = await readJson(response);
    if (
      result.error !== undefined ||
      result.token_type !== "Bearer" ||
      typeof result.access_token !== "string" ||
      !/^[\x21-\x7e]{1,8192}$/.test(result.access_token)
    ) {
      throw new AuthError(
        "Invalid Google login response.",
        401,
        "invalid_identity",
      );
    }
    if (
      result.expires_in !== undefined &&
      (!Number.isSafeInteger(result.expires_in) || result.expires_in <= 0)
    )
      throw new AuthError(
        "Invalid Google login response.",
        401,
        "invalid_identity",
      );
    // Access/refresh tokens are deliberately not persisted or returned.
    return this.verifyIdToken(result.id_token, nonce);
  }

  async signingKey(kid) {
    const now = this.clock();
    let key = this.keyCache.keys.find((candidate) => candidate.kid === kid);
    if (!key || this.keyCache.expiresAt <= now) {
      let response;
      try {
        response = await this.fetcher(JWKS_ENDPOINT, {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: { Accept: "application/json" },
        });
      } catch {
        throw new AuthError(
          "Google signing keys are unavailable.",
          503,
          "google_unavailable",
        );
      }
      if (
        response.status !== 200 ||
        (response.url && response.url !== JWKS_ENDPOINT)
      )
        throw new AuthError(
          "Google signing keys are unavailable.",
          503,
          "google_unavailable",
        );
      const document = await readJson(response);
      if (
        !Array.isArray(document.keys) ||
        document.keys.length > 20 ||
        !document.keys.every(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            !Array.isArray(candidate),
        )
      ) {
        throw new AuthError(
          "Invalid Google signing keys.",
          503,
          "google_unavailable",
        );
      }
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
        response.headers.get("cache-control") || "",
      );
      this.keyCache.keys = document.keys;
      this.keyCache.expiresAt =
        now + Math.min(Number(maxAge?.[1] ?? 300), 86400);
      key = document.keys.find((candidate) => candidate.kid === kid);
    }
    if (
      !key ||
      key.kty !== "RSA" ||
      key.alg !== "RS256" ||
      (key.use !== undefined && key.use !== "sig") ||
      typeof key.n !== "string" ||
      typeof key.e !== "string" ||
      decodeBase64url(key.n).length < 256 ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))
    ) {
      throw new AuthError(
        "Google signing key was not recognized.",
        401,
        "invalid_identity",
      );
    }
    try {
      return await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      throw new AuthError(
        "Invalid Google signing key.",
        401,
        "invalid_identity",
      );
    }
  }

  async verifyIdToken(token, nonce) {
    if (
      typeof token !== "string" ||
      token.length > 16384 ||
      token.split(".").length !== 3
    )
      throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const header = tokenObject(headerPart);
    if (
      header.alg !== "RS256" ||
      (header.typ !== undefined && header.typ !== "JWT") ||
      header.crit !== undefined ||
      typeof header.kid !== "string" ||
      !/^[\x21-\x7e]{1,200}$/.test(header.kid)
    )
      throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
    const key = await this.signingKey(header.kid);
    let signatureValid = false;
    try {
      signatureValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decodeBase64url(signaturePart),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
    } catch {
      /* Invalid signatures are rejected below. */
    }
    if (!signatureValid)
      throw new AuthError(
        "Google identity signature did not verify.",
        401,
        "invalid_identity",
      );
    const claims = tokenObject(payloadPart);
    const audienceValid =
      claims.aud === this.config.clientId ||
      (Array.isArray(claims.aud) &&
        claims.aud.length === 1 &&
        claims.aud[0] === this.config.clientId);
    if (
      !audienceValid ||
      !["accounts.google.com", "https://accounts.google.com"].includes(
        claims.iss,
      ) ||
      (claims.azp !== undefined && claims.azp !== this.config.clientId)
    ) {
      throw new AuthError(
        "Google identity is not intended for this application.",
        401,
        "invalid_identity",
      );
    }
    const now = this.clock();
    if (
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > now + 60 ||
      claims.iat < now - FLOW_SECONDS - 60 ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      (claims.nbf !== undefined &&
        (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))
    ) {
      throw new AuthError(
        "Google identity has invalid timestamps.",
        401,
        "invalid_identity",
      );
    }
    if (
      !equalSecret(claims.nonce, nonce) ||
      !validSubject(claims.sub) ||
      claims.email_verified !== true ||
      typeof claims.email !== "string" ||
      claims.email !== claims.email.trim()
    ) {
      throw new AuthError(
        "Google identity requires the matching nonce, subject and verified email.",
        401,
        "invalid_identity",
      );
    }
    const email = normalizeEmail(claims.email);
    if (
      claims.hd !== undefined &&
      (typeof claims.hd !== "string" ||
        claims.hd.length > 253 ||
        !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
          claims.hd,
        ))
    )
      throw new AuthError(
        "Invalid Google hosted domain.",
        401,
        "invalid_identity",
      );
    return {
      email,
      sub: claims.sub,
      authoritativeEmail:
        email.endsWith("@gmail.com") || typeof claims.hd === "string",
    };
  }
}
