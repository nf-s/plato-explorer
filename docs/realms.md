# Realms

A realm is one corpus with its own graph, articles and search index. The app shows one realm at a time. Connections are drawn only between nodes of the same realm. A node that also exists in another realm has a link that opens it there.

| Realm      | Source                              | Build guide                     |
| ---------- | ----------------------------------- | ------------------------------- |
| Philosophy | Stanford Encyclopedia of Philosophy | [README](../README.md)          |
| Psychology | English Wikipedia                   | [Psychology realm](psychology.md) |

## Settings

| File                         | Purpose                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `realms/app.json`            | The Pages project and the realms in menu order. The first realm is the default               |
| `realms/<id>/realm.json`     | Interface settings shipped to the browser: name, source credit, notices, defaults, subjects  |
| `realms/<id>/build.json`     | Local build settings: source rows, curation folder and people list                           |
| `realms/link_exclusions.json` | Reviewed false matches between realms, one node per realm in each entry                     |

Philosophy's curation files remain in `scripts/`. Psychology's are in `realms/psychology/`.

## Storage

Every realm is stored the same way, as static JSON files under `web/data/<id>/`. Git ignores the whole folder.

| File                    | Contents                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `web/data/realms.json`  | The built realms, for the realm menu                            |
| `<id>/realm.json`       | A copy of the realm's interface settings                        |
| `<id>/graph.json`       | Nodes, connections and communities. [Data model](data-model.md) |
| `<id>/articles/<node>.json` | One article with its linked spans                           |
| `<id>/search/`          | The full-text index. [Search](search.md)                        |
| `<id>/links.json`       | Shared nodes, as `{other realm: {local node: other node}}`      |

The app needs no database or server code. Build reports, word frequencies and keyword reports are written beside these files for local review and are left out of releases.

## Build

```sh
python scripts/build_data.py --realm <id>
python scripts/build_search.py --realm <id>
python scripts/build_realm_links.py
python scripts/serve.py
```

`build_data.py` and `build_search.py` default to the first realm. `build_realm_links.py` compares node titles and aliases across every pair of built realms and rewrites each `links.json`. A person matches only a person. Run it after rebuilding any realm's graph. Matches rely on names, so a few join different subjects. Add those pairs to `realms/link_exclusions.json`.

## Addresses

`?realm=<id>` selects a realm. An address without it, or with an unknown realm, opens the default. Addresses shared before realms existed therefore keep working. Choosing a realm loads the page afresh, so each realm keeps its own graph, reader cache, search index and history.

## Adding a realm

1. Create `realms/<id>/` with `realm.json`, `build.json` and the curation files `aliases.json`, `extra_nodes.json` and `mention_rules.json`.
2. Produce source rows in the schema `build_data.py` reads. [Optional row fields](data-model.md#realms-and-optional-row-fields)
3. Add the ID to `realms/app.json`, then run the build commands above.

The Wikipedia scripts currently write psychology's intermediate files to fixed paths and estimate subjects from psychology terms. Give them a realm option before using them for a second Wikipedia realm.

A Pages project on the Free plan accepts 20,000 files of up to 25 MiB each. The two realms use about 10,050. A realm of 8,000 articles adds about 8,100, so a fourth realm needs articles packed into shared files first.
