import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1AccessStore } from "./store.mjs";
import { OAuthService } from "./service.mjs";
import { configFromEnv } from "./security.mjs";

export const NOW = 1800000000;
export const ENV = {
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-only-client-secret",
  PUBLIC_URL: "https://docs.example.com",
  ADMIN_EMAIL: "admin@example.com",
};

// Executes real SQLite SQL/transactions through the subset of D1 used here.
// Production D1 integration remains a separate deployment verification step.
export class LocalD1 {
  constructor(
    filename = ":memory:",
    migrate = true,
    { readOnly = false } = {},
  ) {
    if (readOnly && migrate)
      throw new Error("Read-only databases cannot apply migrations");
    this.database = new DatabaseSync(filename, { readOnly });
    if (migrate)
      this.database.exec(
        readFileSync(
          new URL("./migrations/0001_access.sql", import.meta.url),
          "utf8",
        ),
      );
  }
  withSession(constraint) {
    if (constraint !== "first-primary")
      throw new Error("Unexpected consistency constraint");
    return this;
  }
  prepare(sql) {
    const statement = this.database.prepare(sql);
    const bound = (values) => ({
      bind: (...nextValues) => bound(nextValues),
      first: async () => statement.get(...values) ?? null,
      all: async () => ({ success: true, results: statement.all(...values) }),
      run: async () => ({
        success: true,
        meta: { changes: Number(statement.run(...values).changes) },
      }),
    });
    return bound([]);
  }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.database.close();
  }
}

export function harness(env = ENV, binding = new LocalD1()) {
  let now = NOW;
  const config = configFromEnv(env);
  const store = new D1AccessStore(binding, config);
  const provider = {
    identity: null,
    calls: [],
    async exchange(code, verifier, nonce) {
      this.calls.push({ code, verifier, nonce });
      return this.identity;
    },
  };
  const clock = () => now;
  const auth = new OAuthService(config, store, provider, clock);
  return {
    env: { ...env, AUTH_DB: binding },
    binding,
    config,
    store,
    provider,
    auth,
    clock,
    advance(seconds) {
      now += seconds;
    },
    dependencies: { store, provider, clock },
    async login(
      identity = {
        email: ENV.ADMIN_EMAIL,
        sub: "admin-123",
        authoritativeEmail: true,
      },
    ) {
      provider.identity = identity;
      const start = await auth.beginLogin("/?doc=manual%2Fkeyword_store");
      const state = new URL(start.authorizationUrl).searchParams.get("state");
      return auth.finishLogin({
        code: "server-issued-code",
        state,
        browserToken: start.browserToken,
      });
    },
  };
}
