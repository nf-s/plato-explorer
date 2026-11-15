# Realms

A realm is one corpus with its own graph, articles and search index. The app shows one realm at a time. Connections are drawn only between nodes of the same realm. A node that also exists in another realm has a link that opens it there.

| ID                     | Realm      | Covers                     | Source                              | Build guide                             |
| ---------------------- | ---------- | -------------------------- | ----------------------------------- | --------------------------------------- |
| `philosophy`           | Philosophy | Philosophy                 | Stanford Encyclopedia of Philosophy | [README](../README.md)                  |
| `philosophy-wikipedia` | Philosophy | Philosophy                 | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| `psychology`           | Psychology | Psychology                 | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| `economics`            | Economics  | Economics                  | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| `society`              | Society    | Sociology and anthropology | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| `religion`             | Religion   | Religion and theology      | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| `mythology`            | Mythology  | Mythology and folklore     | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |

The two Philosophy realms share a name. The realm menu shows each realm's source beneath its name, and a link from another realm reads “Philosophy (SEP)” or “Philosophy (Wikipedia)”.

## Settings

| File                          | Purpose                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `realms/app.json`             | The Pages project, the bucket for released articles and the realms in menu order. The first realm is the default |
| `realms/<id>/realm.json`      | Interface settings shipped to the browser: name, source credit, notices, defaults, subjects                      |
| `realms/<id>/build.json`      | Local build settings: source rows, curation folder and people list                                               |
| `realms/<id>/scope.json`      | Wikipedia realms only: which articles are nominated and how subjects are estimated                               |
| `realms/link_exclusions.json` | Reviewed false matches between realms, one node per realm in each entry                                          |

The SEP realm's curation files remain in `scripts/`. Every other realm's are in its own `realms/<id>/` folder.

## Storage

Every realm is stored the same way, as static JSON files under `web/data/<id>/`. Git ignores the whole folder.

| File                        | Contents                                                        |
| --------------------------- | --------------------------------------------------------------- |
| `web/data/realms.json`      | The built realms, for the realm menu                            |
| `<id>/realm.json`           | A copy of the realm's interface settings                        |
| `<id>/graph.json`           | Nodes, connections and communities. [Data model](data-model.md) |
| `<id>/articles/<node>.json` | One article with its linked spans                               |
| `<id>/search/`              | The full-text index. [Search](search.md)                        |
| `<id>/links.json`           | Shared nodes, as `{other realm: {local node: other node}}`      |

The local preview serves these files as they are. The build also writes build reports, word frequencies and keyword reports beside them. They are left out of releases.

### Where a release keeps the data

Opening an article downloads that article and nothing else. One file per article means a Wikipedia realm has 7,000 to 10,000 files, and a Pages project on the Free plan accepts 20,000 files in all. A release therefore splits the data in two.

| Data                                                                                           | Kept in                                                                         | Served by                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| The app, `realms.json` and each realm's `realm.json`, `graph.json`, `links.json` and `search/` | The Pages project, at the same paths as locally                                 | Pages, as static assets            |
| Articles                                                                                       | An R2 bucket, one object per article, under the key `<id>/articles/<node>.json` | `web/_worker.js`, a Pages Function |

The browser asks for `./data/<id>/articles/<node>.json` in both cases. The staged `_routes.json` sends only those paths to the Function, which reads the object from the bucket and returns it with the crawl and security headers. Every other request is a static asset and does not invoke it. [Public deployment](public-deployment.md)

Limits to keep in mind:

- A realm's `graph.json` must stay under 25 MiB, the largest file Pages accepts. Religion is the largest at about 21 MiB.
- The Pages project holds about 130 files per realm, so the 20,000-file limit is far away.
- Each article opened is one Function request and one bucket read. Search results and link previews load articles too, eight for a page of search excerpts. The Workers Free plan allows 100,000 Function requests a day across the whole account. R2's free allowance is 10 GB stored and 10 million reads a month.

Three alternatives were considered and set aside.

- Packing several articles into each file kept everything in one Pages project, but opening an article downloaded its neighbours in the pack as well.
- A Pages project for each realm's data kept every request static and free. It was built and then withdrawn, because Cloudflare's terms do not allow use intended to get around a service's limits, and the split existed only to stay under the per-project file limit.
- Reading byte ranges from a few large static files does not work, because Pages answers a range request with the whole file.

## Build

```sh
python scripts/build_data.py --realm <id>
python scripts/build_search.py --realm <id>
python scripts/build_realm_links.py
python scripts/serve.py
```

`build_data.py` and `build_search.py` default to the first realm. `build_realm_links.py` rewrites each `links.json` for every pair of built realms. Run it after rebuilding any realm's graph.

- Two realms from the same source share a node when both hold the same article, so the Wikipedia realms are joined by article address.
- The SEP realm is joined to the others by node titles and aliases. A person matches only a person. Names can join different subjects, such as the SEP's Chaos and the Chaos of Greek cosmogony. Add those pairs to `realms/link_exclusions.json`. The matches whose titles differ have been reviewed, including the 300 with Wikipedia's Philosophy. Matches with identical titles have not.

## Addresses

`?realm=<id>` selects a realm. An address without it, or with an unknown realm, opens the default. Addresses shared before realms existed therefore keep working. Choosing a realm loads the page afresh, so each realm keeps its own graph, reader cache, search index and history.

## Adding a realm

1. Create `realms/<id>/` with `realm.json`, `build.json` and the curation files `aliases.json`, `extra_nodes.json` and `mention_rules.json`.
2. Produce source rows in the schema `build_data.py` reads. [Optional row fields](data-model.md#realms-and-optional-row-fields) For a Wikipedia realm, add `scope.json` and run `build_wikipedia_realm.py`. [Wikipedia realms](wikipedia-realms.md)
3. Add the ID to `realms/app.json`, then run the build commands above.
