# Public Cloudflare Pages deployment

Cloudflare Pages serves the frontend, graphs, search indexes and article JSON without sign-in. The app's Pages project is `plato-network` and its production branch is `main`. Articles are kept in an R2 bucket and served by one Pages Function. Both names are in `realms/app.json`.

This is a Direct Upload project with no connected Git source. Pushing source to GitHub does not deploy the app. Releases upload the verified local files with Wrangler. Wrangler reports the deployment URL after each release.

The public project has one Function, `web/_worker.js`, with one binding, the articles bucket. It has no D1 bindings, environment variables or authentication API. The previous private Worker and its access database have their own resources. [Legacy deployment reference](deployment.md)

## What a release contains

A release has two parts. [Where a release keeps the data](realms.md#where-a-release-keeps-the-data)

| Part     | Command                               | Contents                                                                                                                                         | Destination                            |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Articles | `deploy_public.py --articles <realm>` | One object per article in the realm's graph, keyed `<realm>/articles/<node>.json`                                                                | The bucket in `realms/app.json`        |
| The app  | `deploy_public.py`                    | The frontend allowlist, the Function, `_routes.json`, `data/realms.json` and each realm's `realm.json`, `links.json`, `graph.json` and `search/` | The Pages project in `realms/app.json` |

Upload a realm's articles before releasing an app that lists it. The app release stops if any article in a built realm has not been uploaded. Run `scripts/build_realm_links.py` before releasing the app.

The staged `_routes.json` lists `/data/<realm>/articles/*` for each built realm. Only those requests invoke the Function. Local build reports are left out.

The Pages Free plan accepts 20,000 files per project and 25 MiB per file. The script refuses to stage more files, and a release holds about 130 per realm.

The psychology realm was first released to a separate Pages project, `psyche-network`. Retire or redirect it once the combined app is released.

### One-time setup

R2 must be enabled for the account in the Cloudflare dashboard, which asks for a payment method. Then create the bucket once:

```sh
wrangler r2 bucket create plato-network-articles
```

The app release binds the bucket to the Function as `ARTICLES`, so no dashboard binding is needed.

### Uploading articles

`--articles <realm>` uploads the articles that are new or have changed since the last upload from this checkout. It keeps a record of what it uploaded in `.artifacts/uploaded/<bucket>/<realm>.json`. Without that record every article is uploaded again, which is safe and slow.

Wrangler uploads objects through the Cloudflare API, which accepts 1,200 requests in five minutes. The script sends 1,000 articles, records them and waits for the rest of the five minutes, so a realm of 10,000 articles takes about 50 minutes and an interrupted upload resumes where it stopped. The upload uses `wrangler r2 bulk put`, which Wrangler marks experimental.

An article dropped from a realm's graph stays in the bucket. The script reports how many there are. The app no longer links to them. Remove one with `wrangler r2 object delete <bucket>/<realm>/articles/<node>.json --remote`.

## Local deployment skill

Where installed, the personal `nfs-cloudflare-deploy` skill points maintainers to the appropriate release guide. Its general MA3 workflow describes Google sign-in, administrator grants, and a private Worker. Its Plato-specific route uses this public runbook. Preserve the existing public Pages architecture and neutral hostname for normal Plato releases.

## Prepare and release

Release only on an explicit deployment request to an agreed destination. The upload includes article text. Confirm permission from the relevant rights holders for the proposed public redistribution before uploading it. [Copyright and terms](../COPYRIGHT.md)

Generated data must already be present under `web/data/<realm>/`. Rebuild the corpus and full-text index using the [README commands](../README.md) when source data, aliases, matching rules, or search generation change. The public deployment script does not rebuild them.

For local review without network changes:

```sh
python3 scripts/deploy_public.py --prepare-only
```

The command stages `.artifacts/public/`, an ignored directory containing the explicit frontend allowlist in `scripts/deploy_public.py`, the realm list and each realm's settings, graph and search index. New frontend dependencies must be added to that allowlist. It includes `navigation.js`, `manifest.webmanifest`, the `icons/` SVG/PNG assets, `robots.txt`, `_headers` and the Function `_worker.js`. Articles, account/login assets, the private Worker's source, its Wrangler configuration and credentials are excluded. `--prepare-only` stages files without running checks or tests.

For an authorized release, authenticate Wrangler for the target Cloudflare account and set `CLOUDFLARE_ACCOUNT_ID` in your environment. The Pages helper requires the account ID from the caller. Run from the repository root with Wrangler on PATH.

```sh
python3 scripts/deploy_public.py --articles psychology
python3 scripts/deploy_public.py
```

Use `--wrangler /path/to/wrangler/bin/wrangler.js` to specify a Wrangler installation.

The app release runs syntax checks and `npm test`, confirms that every article has been uploaded, stages fresh assets in a clean temporary directory outside the repository, and invokes `wrangler pages deploy` there with the target project and production branch `main`. It writes a `wrangler.json` beside the staged files that names the project, a compatibility date and the `ARTICLES` bucket binding. Wrangler takes the Function's bindings from that file, and it replaces any bindings set for the project in the dashboard.

Keep the release out of the repository folder. Wrangler reads the nearest configuration above its working directory. Run from `.artifacts/`, it picked up the private Worker's `wrangler.jsonc` and `.dev.vars` from the repository root and offered the private database binding to the public project. Pages does not support a custom configuration-file path. Reuse the existing Pages project for subsequent releases.

`scripts/deploy.py` and plain `wrangler deploy` belong to the legacy private Worker workflow. The legacy script rebuilds data, applies D1 migrations and uploads authentication secrets.

Cloudflare's [Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/) describes this upload model.

## Requests and costs

The graph, the realm settings and the full-text index are static assets. Requests for them are free and unlimited on Pages and invoke no Function. Search runs in the browser and fetches the relevant index shards. [Search and request behavior](search.md)

Each article is one Function request and one R2 read. The reader, link previews and the excerpts on a page of search results all load articles, eight for a page of results. The browser revalidates a cached article with its ETag, which is still one request and one read. No request issues a D1 query or an authentication read.

| Allowance on the free plans          | Amount                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Function requests                    | 100,000 a day, shared by every Worker and Pages Function on the account |
| R2 storage                           | 10 GB. The seven realms' articles total about 1.3 GB                    |
| R2 reads (Class B)                   | 10 million a month                                                      |
| R2 writes (Class A), used by uploads | 1 million a month. A full upload is about 56,000                        |
| R2 egress                            | Free                                                                    |

Once the daily Function allowance is used, articles stop loading until the next day (UTC), while the graph and search index keep working. Beyond the free R2 allowances the account is billed at R2's rates. For current figures consult [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The separate legacy Worker reads its own authentication database when users visit that deployment.

## Crawling, headers, and attribution

`robots.txt` disallows every path for compliant crawlers. The wildcard rule in `web/_headers` sends `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on static responses, including graphs, search indexes, and installation assets. Pages does not apply `_headers` to Function responses, so `web/_worker.js` sets the crawler, `nosniff` and referrer headers on articles itself, and a test keeps the two in step. HTML also carries a robots meta tag. These directives request exclusion from crawling and indexing. A crawler can ignore them.

The same header rule provides `nosniff`, `no-referrer`, framing restrictions, a content policy limited to the app, and disabled camera/microphone/geolocation permissions. The graph uses inline styles for positioning. Script execution is restricted to same-origin files and Cloudflare Web Analytics. The Pages project injects its own analytics beacon at the edge; keep shared HTML free of manual beacons. The CSP permits only `https://static.cloudflareinsights.com` for its script and `https://cloudflareinsights.com` for collection. [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)

Retain article author attribution, original SEP links, and the reader's copyright notice. The **About & copyright** panel identifies the authors' article rights and the Metaphysics Research Lab, Stanford University, links to SEP's copyright information, and states that this project is not affiliated with or endorsed by SEP or Stanford. Attribution and crawler directives do not grant permission to reuse the source content.

## Home Screen installation

The manifest uses a stable root identity, root start URL/scope, and standalone display. The allowlist includes the 180px Apple touch icon, 192px/512px manifest icons, and SVG source. Preserve these assets and their links in `index.html` when changing the page shell.

On iPhone Safari, choose **Share → Add to Home Screen**, enable **Open as Web App** if shown, and add **Plato**. The icon opens the app in a standalone window. The app fetches graph and article data over the network. A release includes installation metadata and icons, with no service worker or offline corpus cache.

## Verify a release

Confirm that Pages reports a successful production deployment for `plato-network` with no Git source, one R2 binding named `ARTICLES`, and no D1 bindings or environment variables. Keep the deployment ID with the local verification results.

Check unauthenticated GET and HEAD requests against both canonical and deployment-specific hostnames for the following assets.

- `/`, `/app.js`, `/navigation.js`, and `/styles.css`
- `/robots.txt`, `/manifest.webmanifest`, and the Apple touch and manifest icons
- `/data/realms.json`, then for each realm `/data/<id>/realm.json`, `/graph.json`, `/search/manifest.json`, a search shard, and an article such as `/data/philosophy/articles/nietzsche.json`. An article response must be compressed, carry an ETag and answer a matching `If-None-Match` with 304. A missing article is a 404.

Responses must carry the expected crawl and security headers and load without authentication redirects or session cookies. `/index.html` may redirect to `/` because Pages canonicalizes HTML paths. Compare deployed content with the freshly staged files where practical. Confirm `robots.txt` disallows `/`. Cloudflare's edge has rejected Python's default urllib user agent with error 1010. A browser check distinguished this edge response from a failing app in the original release.

Browser-check desktop and mobile graph layout, full-text queries such as `panopticon` and `veganism`, article loading, exact passage links, copyright notices, contents navigation, Back/Forward, and scroll restoration. Check for console errors, failed asset requests, and CSP violations. Verify that the manifest and icons load, and that there are no `/api/session` requests or account/login controls. A physical iPhone Home Screen installation check is separate from browser metadata checks.

## NFS home directory

The separate NFS home launcher maintains its own Plato entry. Its source is `docs/links/index.html` in the separate `nf-s/nfs-home` repository. The launcher grid uses `<a class="app" ... target="_self">` links. Follow that existing markup and preserve the single Plato entry across releases.

If the canonical address changes, update and verify that separate directory entry using the target repository's current `AGENTS.md` and publishing workflow. Those instructions govern its Git operations. A Cloudflare upload and publication of an NFS home change are separate actions. Check the published directory after editing its link.
