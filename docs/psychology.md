# Psychology realm

The Psychology realm is built from English Wikipedia articles about psychology. It uses the same app, graph builder and search builder as Philosophy. [Realms](realms.md)

| File                           | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `realms/psychology/scope.json` | The WikiProject categories and Wikidata classes that nominate articles                    |
| `realms/psychology/*.json`     | Hand-reviewed aliases, extra nodes and matching rules, in the formats Philosophy uses     |

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

Run the steps in order from the repository root. The scope step queries Wikidata once a minute and caches each answer, so its first run takes about a quarter of an hour.

```sh
python scripts/wikipedia_extract.py index
python scripts/wikipedia_scope.py
python scripts/wikipedia_extract.py extract --titles data/wikipedia/candidates.json --output data/wikipedia/candidates.jsonl
python scripts/wikipedia_select.py expand
python scripts/wikipedia_extract.py extract --titles data/wikipedia/neighbours.json --output data/wikipedia/neighbours.jsonl
python scripts/wikipedia_select.py select
python scripts/wikipedia_rows.py
python scripts/build_data.py --realm psychology
python scripts/build_search.py --realm psychology
python scripts/build_realm_links.py
python scripts/serve.py
```

`wikipedia_rows.py` writes rows in the schema `build_data.py` reads for the SEP, with optional fields for the article address, person flag, subject, aliases and blocked titles. The graph, reader and search steps are shared by every realm.

## Which articles are included

Candidates come from two places. WikiProject Psychology rates about 11,000 articles by importance. Wikidata supplies people by occupation (psychologist, psychiatrist, psychoanalyst, psychotherapist) and members of classes such as mental disorder, cognitive bias, emotion and personality trait.

Wikidata classes include many unrelated items. The emotion tree reaches national anthems and psalms. Selection therefore counts links from _trusted_ articles, meaning those the WikiProject rates or people found by occupation.

| Article                                  | Kept when                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Rated Top, High or Mid                   | Always                                                                 |
| Rated Low, or a person by occupation     | At least 3 trusted articles link to it                                 |
| Wikidata class member only               | At least 3 trusted links, and 20% of its own links stay in the field   |
| Not nominated, linked from the field     | At least 10 trusted links, and 20% of its own links stay in the field  |

The last row is how the corpus grows beyond the seeds. It adds articles such as neurotransmitters and statistical methods that the field relies on. The current snapshot yields 7,994 articles, of which 2,551 are people. Each threshold is a command-line option of `wikipedia_select.py select`.

## How mentions are matched

Wikipedia titles include ordinary words. An article called Time would otherwise claim every use of the word. `wikipedia_rows.py` measures each phrase against the corpus's own links. Of the articles that use a phrase, it counts the share that also link to the article the phrase would point to.

- A **title** is kept unless at least 10 other articles use it and under 5% of them link to the article. Blocked titles include Time, Role and Experience. Their articles remain in the graph and can still be reached through links and search.
- An **alias** comes from link text used by at least two articles. A phrase needs a 10% share and a single word 20%. The share must also be three times the article's ordinary link rate, because much of the corpus links to Psychology whether or not it says “psychological”.
- A **surname** needs a 50% share. “Freud” passes. A surname shared by several psychologists does not.

`data/psychology/matching-report.json` lists every decision with its share. Review it after changing a threshold. Corrections that the measurements cannot make belong in `realms/psychology/aliases.json` and `mention_rules.json`.

## Licence

Wikipedia text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The reader credits Wikipedia contributors, links each article to its Wikipedia page and states the licence. Text adapted from Wikipedia stays under the same licence. [Copyright notice](../COPYRIGHT.md)

## Known limits

- People are identified from Wikidata occupations and infobox fields. Some are missed and appear as topics.
- Subjects are estimated from the nominating class and words in the introduction.
- The realm has no keyword nodes or people without articles yet. `realms/psychology/extra_nodes.json` accepts them in the Philosophy format.
- The snapshot omits most “See also” sections, so few connections are flagged as related entries.
- Lists become bulleted paragraphs. Tables, images, formulas and references are omitted.
