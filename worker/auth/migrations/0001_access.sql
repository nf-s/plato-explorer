-- AUTH_DB only: persistent account state, never the rebuildable corpus index.
CREATE TABLE access_grants (
  email TEXT PRIMARY KEY,
  subject TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  managed_admin INTEGER NOT NULL DEFAULT 0 CHECK (managed_admin IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE access_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES access_grants(email),
  subject TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_email ON access_sessions(email);
CREATE INDEX sessions_expiry ON access_sessions(expires_at);

CREATE TABLE access_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX flows_expiry ON access_flows(expires_at);

CREATE TABLE access_enrollments (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX enrollments_expiry ON access_enrollments(expires_at);

CREATE TABLE access_audit (
  id INTEGER PRIMARY KEY,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL,
  target_email TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
