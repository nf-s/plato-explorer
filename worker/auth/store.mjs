import {
  AuthError,
  EnrollmentRequired,
  normalizeEmail,
  validSubject,
} from "./security.mjs";

// Every decision reads the primary, including when D1 read replication is on.
// A replacement store must preserve one-use flows and transactional checks.
export class D1AccessStore {
  constructor(binding, config) {
    if (
      !binding ||
      typeof binding.prepare !== "function" ||
      typeof binding.batch !== "function"
    )
      throw new AuthError(
        "Access storage is not configured.",
        503,
        "configuration_error",
      );
    this.db =
      typeof binding.withSession === "function"
        ? binding.withSession("first-primary")
        : binding;
    this.config = config;
  }

  statement(sql, ...values) {
    return this.db.prepare(sql).bind(...values);
  }

  async storage(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        "Access storage is unavailable.",
        503,
        "storage_unavailable",
      );
    }
  }

  async createFlow(flow, now) {
    return this.storage(async () => {
      const results = await this.db.batch([
        this.statement("DELETE FROM access_flows WHERE expires_at<=?", now),
        this.statement("DELETE FROM access_sessions WHERE expires_at<=?", now),
        this.statement(
          "INSERT INTO access_flows SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM access_flows)<1000",
          flow.stateHash,
          flow.browserHash,
          flow.nonce,
          flow.verifier,
          flow.returnTo,
          flow.expiresAt,
        ),
        this.statement(
          "DELETE FROM access_enrollments WHERE expires_at<=?",
          now,
        ),
      ]);
      if (results[2].meta.changes !== 1)
        throw new AuthError(
          "Too many pending logins. Try again later.",
          429,
          "login_capacity",
        );
    });
  }

  async consumeFlow(stateHash, browserHash, now) {
    return this.storage(async () => {
      const row = await this.statement(
        "DELETE FROM access_flows WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING *",
        stateHash,
        browserHash,
        now,
      ).first();
      return row
        ? { nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to }
        : null;
    });
  }

  async createEnrollment(tokenHash, email, subject, expiresAt) {
    return this.storage(() =>
      this.statement(
        "INSERT INTO access_enrollments VALUES (?,?,?,?)",
        tokenHash,
        email,
        subject,
        expiresAt,
      ).run(),
    );
  }

  async getEnrollment(tokenHash, now) {
    return this.storage(async () => {
      const row = await this.statement(
        "SELECT email,subject,expires_at FROM access_enrollments WHERE token_hash=? AND expires_at>?",
        tokenHash,
        now,
      ).first();
      return row
        ? { email: row.email, subject: row.subject, expiresAt: row.expires_at }
        : null;
    });
  }

  async createSession(identity, tokenHash, csrfHash, now, expiresAt) {
    return this.storage(async () => {
      const email = normalizeEmail(identity.email);
      if (
        !validSubject(identity.sub) ||
        typeof identity.authoritativeEmail !== "boolean"
      )
        throw new AuthError("Invalid identity.", 403);
      const prior = await this.statement(
        "SELECT * FROM access_grants WHERE email=?",
        email,
      ).first();
      const admin = email === this.config.adminEmail;
      const override = admin && this.config.adminSubject !== null;
      if (override && identity.sub !== this.config.adminSubject)
        throw new AuthError(
          "Google account does not match the administrator binding.",
          403,
          "access_denied",
        );
      if (!admin && (!prior || !prior.enabled || prior.managed_admin))
        throw new AuthError(
          "This account has not been granted access.",
          403,
          "access_denied",
        );
      if (!override && prior?.subject && prior.subject !== identity.sub)
        throw new AuthError(
          "Google account does not match the granted identity.",
          403,
          "access_denied",
        );
      const autoEnroll = identity.authoritativeEmail || override;
      if (!prior?.subject && !autoEnroll)
        throw new EnrollmentRequired(email, identity.sub);
      const statements = [];
      if (admin) {
        statements.push(
          this.statement(
            "DELETE FROM access_sessions WHERE email=? AND EXISTS (SELECT 1 FROM access_grants WHERE email=? AND (subject<>? OR managed_admin<>1))",
            email,
            email,
            identity.sub,
          ),
        );
        statements.push(
          this.statement(
            `INSERT INTO access_grants
          SELECT ?,?,1,1,? WHERE ?=1 OR EXISTS (SELECT 1 FROM access_grants WHERE email=? AND subject=?)
          ON CONFLICT(email) DO UPDATE SET subject=excluded.subject, enabled=1, managed_admin=1, updated_at=excluded.updated_at
          WHERE access_grants.subject=excluded.subject OR (access_grants.subject IS NULL AND ?=1) OR ?=1`,
            email,
            identity.sub,
            now,
            Number(autoEnroll),
            email,
            identity.sub,
            Number(autoEnroll),
            Number(override),
          ),
        );
      } else {
        statements.push(
          this.statement(
            "UPDATE access_grants SET subject=?,updated_at=? WHERE email=? AND enabled=1 AND managed_admin=0 AND (subject=? OR (subject IS NULL AND ?=1))",
            identity.sub,
            now,
            email,
            identity.sub,
            Number(autoEnroll),
          ),
        );
      }
      const sessionIndex = statements.length;
      statements.push(
        this.statement(
          "INSERT INTO access_sessions SELECT ?,email,subject,?,? FROM access_grants WHERE email=? AND subject=? AND enabled=1 AND managed_admin=?",
          tokenHash,
          csrfHash,
          expiresAt,
          email,
          identity.sub,
          Number(admin),
        ),
      );
      statements.push(
        this.statement(
          "INSERT INTO access_audit(actor_subject,action,target_email,occurred_at) SELECT subject,'login',email,? FROM access_sessions WHERE token_hash=?",
          now,
          tokenHash,
        ),
      );
      const results = await this.db.batch(statements);
      if (results[sessionIndex].meta.changes !== 1)
        throw new AuthError(
          "Access changed during login. Start a new login.",
          403,
          "access_denied",
        );
      return { email, sub: identity.sub, isAdmin: admin };
    });
  }

  async getSession(tokenHash, now) {
    return this.storage(async () => {
      const row = await this.statement(
        `SELECT s.*,g.managed_admin FROM access_sessions s
        JOIN access_grants g ON g.email=s.email AND g.subject=s.subject
        WHERE s.token_hash=? AND s.expires_at>? AND g.enabled=1`,
        tokenHash,
        now,
      ).first();
      if (!row) return null;
      const isAdmin = row.managed_admin === 1;
      if (
        isAdmin &&
        (row.email !== this.config.adminEmail ||
          (this.config.adminSubject !== null &&
            row.subject !== this.config.adminSubject))
      )
        return null;
      return {
        principal: { email: row.email, sub: row.subject, isAdmin },
        csrfHash: row.csrf_hash,
        expiresAt: row.expires_at,
      };
    });
  }

  async revokeSession(tokenHash, now) {
    return this.storage(() =>
      this.db.batch([
        this.statement(
          "INSERT INTO access_audit(actor_subject,action,target_email,occurred_at) SELECT subject,'logout',email,? FROM access_sessions WHERE token_hash=?",
          now,
          tokenHash,
        ),
        this.statement(
          "DELETE FROM access_sessions WHERE token_hash=?",
          tokenHash,
        ),
      ]),
    );
  }

  async administrator(actorHash, now) {
    const session = await this.getSession(actorHash, now);
    if (!session?.principal.isAdmin)
      throw new AuthError(
        "Administrator access is required.",
        403,
        "access_denied",
      );
    return session.principal;
  }

  actorGuard() {
    return `EXISTS (SELECT 1 FROM access_sessions s JOIN access_grants g ON g.email=s.email AND g.subject=s.subject
      WHERE s.token_hash=? AND s.expires_at>? AND g.email=? AND g.enabled=1 AND g.managed_admin=1
      AND (? IS NULL OR g.subject=?))`;
  }

  actorValues(actorHash, now) {
    return [
      actorHash,
      now,
      this.config.adminEmail,
      this.config.adminSubject,
      this.config.adminSubject,
    ];
  }

  async listGrants(actorHash, now) {
    return this.storage(async () => {
      await this.administrator(actorHash, now);
      const result = await this.statement(
        `SELECT email,subject,enabled,managed_admin,updated_at FROM access_grants WHERE ${this.actorGuard()} ORDER BY email`,
        ...this.actorValues(actorHash, now),
      ).all();
      if (!result.results.length)
        throw new AuthError(
          "Administrator access is required.",
          403,
          "access_denied",
        );
      return result.results.map((row) => ({
        email: row.email,
        subject: row.subject,
        enabled: row.enabled === 1,
        isAdmin: row.managed_admin === 1,
        updatedAt: row.updated_at,
      }));
    });
  }

  async grantEmail(actorHash, email, subject, now) {
    return this.storage(async () => {
      const actor = await this.administrator(actorHash, now);
      email = normalizeEmail(email);
      if (subject !== null && !validSubject(subject))
        throw new AuthError("Invalid Google subject.");
      if (email === this.config.adminEmail)
        throw new AuthError(
          "The environment administrator is managed through configuration.",
          403,
          "managed_admin",
        );
      const guard = this.actorGuard();
      const values = this.actorValues(actorHash, now);
      const results = await this.db.batch([
        this.statement(
          `DELETE FROM access_sessions WHERE email=? AND ${guard}`,
          email,
          ...values,
        ),
        this.statement(
          `INSERT INTO access_grants SELECT ?,?,1,0,? WHERE ${guard}
          ON CONFLICT(email) DO UPDATE SET subject=COALESCE(excluded.subject,access_grants.subject),enabled=1,managed_admin=0,updated_at=excluded.updated_at`,
          email,
          subject,
          now,
          ...values,
        ),
        this.statement(
          `INSERT INTO access_audit(actor_subject,action,target_email,occurred_at) SELECT ?,'grant',?,? WHERE ${guard}`,
          actor.sub,
          email,
          now,
          ...values,
        ),
      ]);
      if (results[1].meta.changes !== 1)
        throw new AuthError(
          "Administrator session expired.",
          403,
          "access_denied",
        );
    });
  }

  async revokeEmail(actorHash, email, now) {
    return this.storage(async () => {
      const actor = await this.administrator(actorHash, now);
      email = normalizeEmail(email);
      if (email === this.config.adminEmail)
        throw new AuthError(
          "The environment administrator is managed through configuration.",
          403,
          "managed_admin",
        );
      const guard = this.actorGuard();
      const values = this.actorValues(actorHash, now);
      const results = await this.db.batch([
        this.statement(
          `UPDATE access_grants SET enabled=0,updated_at=? WHERE email=? AND ${guard}`,
          now,
          email,
          ...values,
        ),
        this.statement(
          `DELETE FROM access_sessions WHERE email=? AND ${guard}`,
          email,
          ...values,
        ),
        this.statement(
          `INSERT INTO access_audit(actor_subject,action,target_email,occurred_at) SELECT ?,'revoke',?,? WHERE ${guard}`,
          actor.sub,
          email,
          now,
          ...values,
        ),
      ]);
      if (results[2].meta.changes !== 1)
        throw new AuthError(
          "Administrator session expired.",
          403,
          "access_denied",
        );
    });
  }
}
