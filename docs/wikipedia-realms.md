# Wikipedia realms

Every realm except the SEP's Philosophy is built from English Wikipedia articles about one field. They use the same app, graph builder and search builder as the SEP realm. [Realms](realms.md)

| Realm      | Nominated by                                                                                   | Articles | People |
| ---------- | ---------------------------------------------------------------------------------------------- | -------- | ------ |
| Philosophy | WikiProject Philosophy; philosophers                                                           | 9,723    | 4,244  |
| Psychology | WikiProject Psychology; psychologists and related occupations; classes such as mental disorder | 7,994    | 2,400  |
| Economics  | WikiProject Economics; economists                                                              | 9,582    | 2,951  |
| Society    | WikiProjects Sociology and Anthropology; sociologists and anthropologists                      | 9,154    | 2,519  |
| Religion   | WikiProject Religion; theologians                                                              | 10,421   | 2,988  |
| Mythology  | WikiProjects Mythology and Folklore                                                            | 6,939    | 249    |

The counts are from the snapshot revision below.

| File                     | Purpose                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `realms/<id>/scope.json` | The WikiProject categories and Wikidata classes that nominate articles, the selection thresholds and the subject terms |
| `realms/<id>/*.json`     | Hand-reviewed aliases, extra nodes and matching rules, in the formats Philosophy uses                                  |

## Source

The articles come from Wikimedia's [Structured Contents snapshot](https://huggingface.co/datasets/wikimedia/structured-wikipedia) on Hugging Face. The English files total about 35 GB in 86 Parquet shards. No account or token is needed. The build was developed against revision `417c267bb457fa645c22eb3b5c77764963194c70`. Redirects come from two Wikimedia dump tables, which avoids thousands of rate-limited API requests. [Wikimedia dumps](https://dumps.wikimedia.org/enwiki/latest/)

```sh
mkdir -p data/wikipedia
hf download wikimedia/structured-wikipedia --repo-type dataset --revision 417c267bb457fa645c22eb3b5c77764963194c70 --include "enwiki/*" --local-dir data/wikipedia-download
mv data/wikipedia-download/enwiki/data/*.parquet data/wikipedia/
curl -L -o data/wikipedia/enwiki-latest-pages-articles-multistream-index.txt.bz2 https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles-multistream-index.txt.bz2
curl -L -o data/wikipedia/enwiki-latest-redirect.sql.gz https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-redirect.sql.gz
```

## Build

Index the snapshot once, then run the steps for each realm from the repository root. Build one realm at a time, because the realms share the redirect cache.

```sh
python scripts/wikipedia_extract.py index
python scripts/build_wikipedia_realm.py --realm <id>
python scripts/build_data.py --realm <id>
python scripts/build_search.py --realm <id>
python scripts/build_realm_links.py
python scripts/serve.py
```

`build_wikipedia_realm.py` runs five steps and keeps their files in `data/wikipedia/<id>/`. Each step is also a command, for rerunning one after changing a threshold.

| Step                                                            | Writes                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `wikipedia_scope.py --realm <id>`                               | `candidates.json`, the nominated titles                 |
| `wikipedia_extract.py extract --realm <id> --titles candidates` | `candidates.jsonl`, their articles                      |
| `wikipedia_select.py --realm <id> expand`                       | `neighbours.json`, well-linked outsiders                |
| `wikipedia_extract.py extract --realm <id> --titles neighbours` | `neighbours.jsonl`, their articles                      |
| `wikipedia_select.py --realm <id> select`                       | `selected.json`, the article set                        |
| `wikipedia_rows.py --realm <id>`                                | `data/<id>/articles.parquet` and `matching-report.json` |

The scope step asks Wikidata one question a minute and caches each answer, so psychology's first run takes about a quarter of an hour.

`wikipedia_rows.py` writes rows in the schema `build_data.py` reads for the SEP, with optional fields for the article address, person flag, subject, aliases and blocked titles. The graph, reader and search steps are shared by every realm.

## Which articles are included

Candidates come from two places, both listed in the realm's `scope.json`. WikiProjects rate articles by importance: WikiProject Psychology rates about 11,000. Wikidata supplies people by occupation and, for psychology, members of classes such as mental disorder, cognitive bias, emotion and personality trait.

Wikidata classes include many unrelated items. The emotion tree reaches national anthems and psalms. Selection therefore counts links from _trusted_ articles, meaning those the WikiProject rates or people found by occupation.

| Article                              | Kept when                                                             |
| ------------------------------------ | --------------------------------------------------------------------- |
| Rated Top, High or Mid               | Always                                                                |
| Rated Low, or a person by occupation | At least 3 trusted articles link to it                                |
| Wikidata class member only           | At least 3 trusted links, and 20% of its own links stay in the field  |
| Not nominated, linked from the field | At least 10 trusted links, and 20% of its own links stay in the field |

The last row is how the corpus grows beyond the seeds. It adds articles such as neurotransmitters and statistical methods that the field relies on. Each threshold is set under `selection` in `scope.json`. Religion and Philosophy use 5 trusted links for the second row and 25 for the last, which keeps each near 10,000 articles and its graph file under the 25 MiB that Pages accepts.

## How mentions are matched

Wikipedia titles include ordinary words. An article called Time would otherwise claim every use of the word. `wikipedia_rows.py` measures each phrase against the corpus's own links. Of the articles that use a phrase, it counts the share that also link to the article the phrase would point to.

- A **title** is kept unless at least 10 other articles use it and under 5% of them link to the article. Blocked titles include Time, Role and Experience. Their articles remain in the graph and can still be reached through links and search.
- The graph builder also matches a title without its leading “The”. That shorter phrase passes the same test, so “Buddha” still finds The Buddha while “philosopher” no longer finds the periodical The Philosopher. Where another article is titled with the shorter phrase, the phrase belongs to that article alone: “man” is decided for Man and never falls to The Man.
- An **alias** comes from link text used by at least two articles. A phrase needs a 10% share and a single word 20%. The share must also be three times the article's ordinary link rate, because much of the corpus links to Psychology whether or not it says “psychological”.
- A **surname** needs a 50% share. “Freud” passes. A surname shared by several psychologists does not.

`data/<id>/matching-report.json` lists every decision with its share. Review it after changing a threshold. Corrections that the measurements cannot make belong in `realms/<id>/aliases.json` and `mention_rules.json`.

## Licence

Wikipedia text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The reader credits Wikipedia contributors, links each article to its Wikipedia page and states the licence. Text adapted from Wikipedia stays under the same licence. [Copyright notice](../COPYRIGHT.md)

## Known limits

- People are identified from Wikidata occupations, infobox fields and the short description. Some are missed and appear as topics, and a few organisations with founding dates appear as people. Legendary kings and prophets count as people in Mythology. Gods do not.
- Subjects are estimated from the nominating class and words in the title and introduction, using the terms in `scope.json`.
- These realms have no keyword nodes or people without articles yet. `realms/<id>/extra_nodes.json` accepts them in the Philosophy format.
- The snapshot omits most “See also” sections, so few connections are flagged as related entries.
- Lists become bulleted paragraphs. Tables, images, formulas and references are omitted.
