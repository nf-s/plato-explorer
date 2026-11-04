import { AUTHORIZATION_ENDPOINT } from "./google.mjs";
import {
  AuthError,
  FLOW_SECONDS,
  SESSION_SECONDS,
  base64url,
  equalSecret,
  hash,
  isOpaque,
  randomToken,
  safeReturnUrl,
} from "./security.mjs";

export class OAuthService {
  constructor(config, store, provider, clock = () => Date.now() / 1000) {
    this.config = config;
    this.store = store;
    this.provider = provider;
    this.clock = clock;
  }

  async beginLogin(returnTo = "/") {
    const now = Math.floor(this.clock());
    const state = randomToken();
    const browserToken = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    await this.store.createFlow(
      {
        stateHash: await hash(state),
        browserHash: await hash(browserToken),
        nonce,
        verifier,
        returnTo: safeReturnUrl(returnTo),
        expiresAt: now + FLOW_SECONDS,
      },
      now,
    );
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return {
      authorizationUrl: `${AUTHORIZATION_ENDPOINT}?${params}`,
      browserToken,
    };
  }

  async finishLogin({ code, state, browserToken, error }) {
    if (!isOpaque(state) || !isOpaque(browserToken))
      throw new AuthError("Invalid Google login callback.");
    const flow = await this.store.consumeFlow(
      await hash(state),
      await hash(browserToken),
      Math.floor(this.clock()),
    );
    if (!flow)
      throw new AuthError(
        "Google login expired or did not match this browser.",
        400,
        "invalid_state",
      );
    if (error !== undefined)
      throw new AuthError(
        "Google login was not completed. Start a new login.",
        400,
        "login_cancelled",
      );
    if (typeof code !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(code))
      throw new AuthError("Invalid Google login callback.");
    const identity = await this.provider.exchange(
      code,
      flow.verifier,
      flow.nonce,
    );
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const now = Math.floor(this.clock());
    const principal = await this.store.createSession(
      identity,
      await hash(sessionToken),
      await hash(csrfToken),
      now,
      now + SESSION_SECONDS,
    );
    return {
      principal,
      sessionToken,
      csrfToken,
      expiresAt: now + SESSION_SECONDS,
      returnTo: flow.returnTo,
    };
  }

  async authenticate(sessionToken) {
    if (!isOpaque(sessionToken)) return null;
    return this.store.getSession(
      await hash(sessionToken),
      Math.floor(this.clock()),
    );
  }

  async csrf(sessionToken, csrfToken, origin) {
    const session = await this.authenticate(sessionToken);
    if (!session)
      throw new AuthError(
        "Authentication is required.",
        401,
        "authentication_required",
      );
    if (
      origin !== this.config.publicUrl ||
      !isOpaque(csrfToken) ||
      !equalSecret(session.csrfHash, await hash(csrfToken))
    )
      throw new AuthError(
        "A valid same-origin CSRF token is required.",
        403,
        "csrf_failed",
      );
    return session;
  }

  async logout(sessionToken, csrfToken, origin) {
    await this.csrf(sessionToken, csrfToken, origin);
    await this.store.revokeSession(
      await hash(sessionToken),
      Math.floor(this.clock()),
    );
  }

  async listGrants(sessionToken) {
    if (!(await this.authenticate(sessionToken)))
      throw new AuthError(
        "Authentication is required.",
        401,
        "authentication_required",
      );
    return this.store.listGrants(
      await hash(sessionToken),
      Math.floor(this.clock()),
    );
  }

  async grantEmail(sessionToken, csrfToken, origin, email, subject = null) {
    await this.csrf(sessionToken, csrfToken, origin);
    return this.store.grantEmail(
      await hash(sessionToken),
      email,
      subject,
      Math.floor(this.clock()),
    );
  }

  async revokeEmail(sessionToken, csrfToken, origin, email) {
    await this.csrf(sessionToken, csrfToken, origin);
    return this.store.revokeEmail(
      await hash(sessionToken),
      email,
      Math.floor(this.clock()),
    );
  }
}
