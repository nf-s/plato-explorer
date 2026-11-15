# Realms

A realm is one corpus with its own graph, articles and search index. The app shows one realm at a time. Connections are drawn only between nodes of the same realm. A node that also exists in another realm has a link that opens it there.

| Realm      | Covers                           | Source                              | Build guide                            |
| ---------- | -------------------------------- | ----------------------------------- | -------------------------------------- |
| Philosophy | Philosophy                       | Stanford Encyclopedia of Philosophy | [README](../README.md)                 |
| Psychology | Psychology                       | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| Economics  | Economics                        | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| Society    | Sociology and anthropology       | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| Religion   | Religion and theology            | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |
| Mythology  | Mythology and folklore           | English Wikipedia                   | [Wikipedia realms](wikipedia-realms.md) |

## Settings

| File                         | Purpose                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `realms/app.json`            | The Pages project and the realms in menu order. The first realm is the default               |
| `realms/<id>/realm.json`     | Interface settings shipped to the browser: name, source credit, notices, defaults, subjects  |
| `realms/<id>/build.json`     | Local build settings: source rows, curation folder and people list                           |
| `realms/<id>/scope.json`     | Wikipedia realms only: which articles are nominated and how subjects are estimated           |
| `realms/link_exclusions.json` | Reviewed false matches between realms, one node per realm in each entry                     |

Philosophy's curation files remain in `scripts/`. Every other realm's are in its own `realms/<id>/` folder.

## Storage

Every realm is stored the same way, as static JSON files under `web/data/<id>/`. Git ignores the whole folder.

| File                      | Contents                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `web/data/realms.json`    | The built realms and the address of each realm's data           |
| `<id>/realm.json`         | A copy of the realm's interface settings                        |
| `<id>/graph.json`         | Nodes, connections and communities. [Data model](data-model.md) |
| `<id>/articles/<node>.json` | One article with its linked spans                             |
| `<id>/search/`            | The full-text index. [Search](search.md)                        |
| `<id>/links.json`         | Shared nodes, as `{other realm: {local node: other node}}`      |

The app needs no database or server code. The build also writes build reports, word frequencies and keyword reports beside these files. They are left out of releases.

### Where a release keeps the data

Opening an article downloads that article and nothing else. One file per article means a Wikipedia realm has 8,000 to 10,000 files, and a Pages project on the Free plan accepts 20,000. A release therefore gives each realm's data a Pages project of its own, named `<app project>-<realm>`, and the app project holds only the app and `realms.json`. Locally `realms.json` points at `./data/<id>/`. In a release it points at each realm's project. [Public deployment](public-deployment.md)

A realm is limited to about 19,800 articles by its project's file limit, and its `graph.json` to 25 MiB.

Three alternatives were considered and set aside.

- Packing several articles into each file kept everything in one project, but opening an article downloaded its neighbours in the pack as well.
- R2 object storage has no file limit. It needs a billing profile on the account and, with no domain on the account, a Function in front of the bucket. Function requests are metered and share a daily allowance with the account's other Workers.
- Reading byte ranges from a few large files does not work, because Pages answers a range request with the whole file.

## Build

```sh
python scripts/build_data.py --realm <id>
python scripts/build_search.py --realm <id>
python scripts/build_realm_links.py
python scripts/serve.py
```

`build_data.py` and `build_search.py` default to the first realm. `build_realm_links.py` rewrites each `links.json` for every pair of built realms. Run it after rebuilding any realm's graph.

- Two realms from the same source share a node when both hold the same article, so the Wikipedia realms are joined by article address.
- Philosophy is joined to the others by node titles and aliases. A person matches only a person. Names can join different subjects, such as the SEP's Chaos and the Chaos of Greek cosmogony. Add those pairs to `realms/link_exclusions.json`. The matches whose titles differ have been reviewed. Matches with identical titles have not.

## Addresses

`?realm=<id>` selects a realm. An address without it, or with an unknown realm, opens the default. Addresses shared before realms existed therefore keep working. Choosing a realm loads the page afresh, so each realm keeps its own graph, reader cache, search index and history.

## Adding a realm

1. Create `realms/<id>/` with `realm.json`, `build.json` and the curation files `aliases.json`, `extra_nodes.json` and `mention_rules.json`.
2. Produce source rows in the schema `build_data.py` reads. [Optional row fields](data-model.md#realms-and-optional-row-fields) For a Wikipedia realm, add `scope.json` and run `build_wikipedia_realm.py`. [Wikipedia realms](wikipedia-realms.md)
3. Add the ID to `realms/app.json`, then run the build commands above.

