# Public Cloudflare Pages deployment

The current public app is [plato-network.pages.dev](https://plato-network.pages.dev/). Cloudflare Pages serves the frontend, graph, article JSON, and search index without sign-in. The Pages project is `plato-network` and its production branch is `main`.

This is a Direct Upload project with no connected Git source. Pushing source to GitHub does not deploy the app. Releases upload the verified local files with Wrangler. Cloudflare returns a deployment-specific `https://<deployment-id>.plato-network.pages.dev` URL alongside the stable canonical address.

The public project has no Pages Functions, D1 bindings, environment variables, or authentication API. The previous private Worker and its access database have their own resources. [Legacy deployment reference](deployment.md)

## Local deployment skill

Where installed, the personal `nfs-cloudflare-deploy` skill points maintainers to the appropriate release guide. Its general MA3 workflow describes Google sign-in, administrator grants, and a private Worker. Its Plato-specific route uses this public runbook. Preserve the existing public Pages architecture and neutral hostname for normal Plato releases.

## Prepare and release

Release only on an explicit deployment request to an agreed destination. The upload includes article text. Confirm permission from the relevant rights holders for the proposed public redistribution before uploading it. [Copyright and terms](../COPYRIGHT.md)

Generated data must already be present under `web/data/`. Rebuild the corpus and full-text index using the [README commands](../README.md) when source data, aliases, matching rules, or search generation change. The public deployment script does not rebuild them.

For local review without network changes:

```sh
python3 scripts/deploy_public.py --prepare-only
```

This stages `.artifacts/public/`, an ignored directory containing the explicit frontend allowlist in `scripts/deploy_public.py` plus generated JSON data. New frontend dependencies must be added to that allowlist. It includes `navigation.js`, `manifest.webmanifest`, the `icons/` SVG/PNG assets, `robots.txt`, and `_headers`. Account/login assets, Worker source, Wrangler configuration, and credentials are excluded. `--prepare-only` stages files without running checks or tests.

For an authorized release, authenticate Wrangler for the target Cloudflare account and set `CLOUDFLARE_ACCOUNT_ID` in your environment. The Pages helper requires the account ID from the caller. Run from the repository root with Wrangler on PATH.

```sh
python3 scripts/deploy_public.py
```

Use `--wrangler /path/to/wrangler/bin/wrangler.js` to specify a Wrangler installation.

The script runs syntax checks and `npm test`, prepares fresh assets, and invokes `wrangler pages deploy` with project `plato-network` and production branch `main`. It runs Wrangler from a clean temporary working directory so it cannot load the private Worker's `wrangler.jsonc` or `.dev.vars`. Pages does not support a custom configuration-file path, so there is no second Wrangler config. Reuse the existing Pages project for subsequent releases.

`scripts/deploy.py` and plain `wrangler deploy` belong to the legacy private Worker workflow. The legacy script rebuilds data, applies D1 migrations and uploads authentication secrets.

Cloudflare's [Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/) describes this upload model.

## Requests and costs

The graph, article reader, and full-text search fetch static assets. Search runs in the browser and fetches the relevant index shards and article JSON for the displayed excerpts. Public browsing and searching issue no D1 queries or authentication reads and invoke no Functions. [Search and request behavior](search.md)

The separate legacy Worker reads its own authentication database when users visit that deployment. For current static hosting charges, consult [Cloudflare Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/#static-asset-requests).

## Crawling, headers, and attribution

`robots.txt` disallows every path for compliant crawlers. The wildcard rule in `web/_headers` sends `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on static responses, including direct article JSON, search indexes, and installation assets. HTML also carries a robots meta tag. These directives request exclusion from crawling and indexing. A crawler can ignore them.

The same header rule provides `nosniff`, `no-referrer`, framing restrictions, a same-origin content policy, and disabled camera/microphone/geolocation permissions. The graph uses inline styles for positioning. Script execution is restricted to same-origin files. Future Functions would need to set their own response headers. [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)

Retain article author attribution, original SEP links, and the reader's copyright notice. The **About & copyright** panel identifies the authors' article rights and the Metaphysics Research Lab, Stanford University, links to SEP's copyright information, and states that this project is not affiliated with or endorsed by SEP or Stanford. Attribution and crawler directives do not grant permission to reuse the source content.

## Home Screen installation

The manifest uses a stable root identity, root start URL/scope, and standalone display. The allowlist includes the 180px Apple touch icon, 192px/512px manifest icons, and SVG source. Preserve these assets and their links in `index.html` when changing the page shell.

On iPhone Safari, choose **Share → Add to Home Screen**, enable **Open as Web App** if shown, and add **Plato**. The icon opens the app in a standalone window. The app fetches graph and article data over the network. A release includes installation metadata and icons, with no service worker or offline corpus cache.

## Verify a release

Confirm that Pages reports a successful production deployment for `plato-network`, `uses_functions: false`, no Git source, and no D1 bindings or environment variables. Record the deployment-specific URL with the verification results and continue sharing the canonical URL.

Check unauthenticated GET and HEAD requests against both canonical and deployment-specific hostnames for the following assets.

- `/`, `/app.js`, `/navigation.js`, and `/styles.css`
- `/robots.txt`, `/manifest.webmanifest`, and the Apple touch and manifest icons
- `/data/graph.json`, an encoded graph path, `/data/articles/nietzsche.json`, `/data/search/manifest.json`, and a search shard.

Responses must carry the expected crawl and security headers and load without authentication redirects or session cookies. `/index.html` may redirect to `/` because Pages canonicalizes HTML paths. Compare deployed content with the freshly staged files where practical. Confirm `robots.txt` disallows `/`. Cloudflare's edge has rejected Python's default urllib user agent with error 1010. A browser check distinguished this edge response from a failing app in the original release.

Browser-check desktop and mobile graph layout, full-text queries such as `panopticon` and `veganism`, article loading, exact passage links, copyright notices, contents navigation, Back/Forward, and scroll restoration. Check for console errors, failed asset requests, and CSP violations. Verify that the manifest and icons load, and that there are no `/api/session` requests or account/login controls. A physical iPhone Home Screen installation check is separate from browser metadata checks.

## NFS home directory

[NFS home](https://nf-s.github.io/nfs-home/links/) links to the canonical `https://plato-network.pages.dev/` URL without a sign-in label. Its source is `docs/links/index.html` in the separate `nf-s/nfs-home` repository. The launcher grid uses `<a class="app" ... target="_self">` links. Follow that existing markup and preserve the single Plato entry across releases.

If the canonical address changes, update and verify that separate directory entry using the target repository's current `AGENTS.md` and publishing workflow. Those instructions govern its Git operations. A Cloudflare upload and publication of an NFS home change are separate actions. Check the published directory after editing its link.
