# Previous private Cloudflare Worker deployment

The current app uses Cloudflare Pages. This guide describes the earlier Google-protected Worker, which has its own access database. The current public frontend omits the account and login controls. Reinstating the private experience requires restoring those controls as well as the asset gate. [Public release guide](public-deployment.md)

## Configuration

For an explicitly requested private deployment to an agreed destination, copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`. Set the target account, Worker, D1 database, administrator email and public URL in the local configuration. Register the matching `/auth/google/callback` URI with the Google Web OAuth client. Keep other registered callbacks when using a shared client. [Configuration template](../wrangler.example.jsonc)

Supply `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the verified administrator Google subject (`ADMIN_SUBJECT`) in the ignored `.dev.vars` with mode `0600`. Keep all live configuration, access records and credentials outside Git. Database migrations create grants, short-lived OAuth flows, hashed sessions, enrollment tickets and an audit trail. Corpus rebuilds do not replace account state.

The Worker follows the MA3 Google sign-in pattern with Plato-specific cookie names. It uses authorization code with S256 PKCE, browser-bound one-use state, nonce checks and RS256 signature verification against Google's fixed JWKS endpoint. Sessions last eight hours. The primary D1 database authorizes each request and revocation immediately removes active sessions.

## Release

Check permission to share the content with the intended audience before uploading it. The deployment script includes generated article and graph files. The GitHub repository contains the source and matching rules only. [Copyright and terms](../COPYRIGHT.md)

With the data prepared locally, the virtual environment configured per the README, and Wrangler on PATH, run the following for an authorized private release.

```sh
python3 scripts/deploy.py
```

The script rebuilds the data and search index, runs checks and tests, applies outstanding D1 migrations, deploys the Worker and uploads secrets using `wrangler secret bulk`. Use `--wrangler /path/to/wrangler/bin/wrangler.js` to specify a Wrangler installation. A Git push is independent of this release operation. [Deployment script](../scripts/deploy.py)

## Legacy access controls

In the private frontend, **Account → Manage access** allowed the administrator to grant, revoke or restore an email. The environment-managed administrator could not be revoked through that UI. Gmail and Google Workspace users could bind their verified Google identity on first approved login. Other custom-domain accounts could require an explicit Google account ID. Supplying a new ID rebinds the email and invalidates previous sessions. An email-only grant preserves an existing binding.

Mutations require the exact application origin and a session CSRF token. The asset gate runs before every request (`assets.run_worker_first: true`), including static JSON requests. Keep the public allowlist restricted to login, health and constrained auth routes. HTML and not-found fallbacks are disabled. Responses include `Cache-Control: no-store`, `Vary: Cookie`, crawler exclusions and a restrictive CSP. The Worker adds a Cloudflare Web Analytics beacon only to successful HTML responses on its configured production hostname, after the access gate. Shared assets remain beacon-free so Pages can inject its separate token. The CSP permits the Cloudflare beacon script and collection origins without widening other directives. Invocation logs are disabled to keep OAuth callback query parameters out of logs.

## Verification

Run `node --test worker/auth/*.test.mjs` for signed-token, replay, CSRF, cookie, subject-binding, revocation, persistence and asset-gate tests. The suite uses Node's built-in SQLite and requires Node 22.13 or later.

After an authorized release, verify that unauthenticated GET and HEAD requests to protected HTML, scripts and data files return 401. The root redirects to login. Missing credentials or storage return 503. Check the callback, S256 PKCE, state, nonce and browser-binding cookie, then complete a real Google sign-in to verify the administrator UI. The public NFS home entry continues to point to the canonical Pages site. [NFS home directory](public-deployment.md#nfs-home-directory)
