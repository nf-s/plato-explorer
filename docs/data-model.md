# Data model and matching

## Source selection

The build reads `data/good-one.parquet`. This structured export was chosen from five overlapping snapshots because it preserves editorial related entries alongside titles, section structure and bibliographies. The optional `python3 scripts/fetch_source.py` command downloads the primary Parquet from `hugfaceguy0001/stanford_plato` at revision `1076853c2f3eefc47bba652dc00459018ce695d1` and verifies its SHA-256. It is a third-party export. Check the terms for your use before downloading. [Dataset](https://huggingface.co/datasets/hugfaceguy0001/stanford_plato) · [Fetcher](../scripts/fetch_source.py) · [Copyright and terms](../COPYRIGHT.md)

The original investigation also compared paragraph-based Parquet, full-text Parquet, PDF-derived CSV and a December 2023 JSONL. Combining them would double-count passages and mix revisions. If you already hold an authorized copy of `stanford-encyclopedia-of-philosophy_dec23.jsonl`, place it beside the primary Parquet to add author attribution where available. All other processing uses the primary snapshot. The fetcher retrieves only that file. The reader preserves the supplied text and section structure, including uppercase characters in SEP IDs. [Source validation and extraction](../scripts/build_data.py)

All input types and nested list structures are validated before processing. No article HTML is injected into the page. The reader creates text nodes and a small set of known DOM elements, and accepts only SEP HTTPS URLs for external article links.

## Mention extraction

1. Decode HTML entities and collapse whitespace in the supplied paragraphs. Preserve text and section ordering.
2. Build a case- and accent-insensitive, whole-word matcher from complete article titles, titles without an initial “The”, explicit aliases, and accepted additional people and keywords. Normalize compatible Unicode hyphens and apostrophes.
3. Compile shared prefixes into a regular-expression trie. Prefer longer phrases at the same position. For example, “Friedrich Nietzsche” counts once and “Virtue Ethics” consumes the complete phrase.
4. Match preamble and main-text paragraphs. Exclude headings, table-of-contents entries, bibliographies, and self-mentions.
5. Omit terms shorter than three normalized characters, blocked forms, and terms with multiple owners. Useful surnames and spelling variants are reviewed individually.
6. Consume configured competing phrases before matching a shorter form inside them. If a configured blocker occurs in an article's text, headings, or bibliography, suppress its associated ambiguous forms throughout that article. Other forms of the target stay eligible.
7. Record non-overlapping UTF-16 text offsets so that the Python pipeline and browser agree even when text contains characters outside the basic multilingual plane.

The same spans supply reader links and directed mention counts. The link audit documents specific decisions for names and concepts. [Matcher](../scripts/text_processing.py) · [Review decisions and validation](link-audit.md)

Related entries are resolved from their source URLs, with capitalization reconciled against known IDs. The pipeline repairs the `entry=` value in a small number of malformed export links without fetching them. Duplicate related entries count once per source and target. When a related entry has no article in the snapshot, its original SEP link remains available in the reader.

## Graph file

This example shows the graph structure with empty arrays. Local builds fill the metadata with measured counts.

```json
{
  "version": 1,
  "meta": {
    "source": "good-one.parquet",
    "sourceSha256": "...",
    "articles": 0,
    "nodes": 0,
    "connections": 0,
    "mentions": 0,
    "relatedLinks": 0,
    "unresolvedRelated": 0,
    "method": "..."
  },
  "nodes": [],
  "edges": [],
  "communities": []
}
```

Each node contains `id`, `title`, `url`, a short `summary`, search `aliases`, incoming `mentions`, the number of distinct articles with a text mention (`references`), total unique neighbors including related entries (`degree`), layout coordinates `x`/`y`, an integer `community`, a boolean `person`, a `subject` label, `kind` (`person`, `topic`, or `keyword`), and `article` (boolean). Articles are sorted by their case-sensitive IDs at the start of the array. Additional people and keywords follow. These nodes have `article: false`, `url: null`, and no article JSON file. Each build records counts in the local `web/data/build-report.json`.

Each edge is a compact six-value tuple.

```text
[sourceIndex, targetIndex, sourceMentionsTarget, targetMentionsSource,
 sourceListsTargetAsRelated, targetListsSourceAsRelated]
```

`sourceIndex < targetIndex` and both refer to the node array. The last two fields are 0 or 1. The graph contains one edge per unordered pair, preserving directional counts independently. No self-edges or empty edges are emitted.

The default view shows people and topics, with keywords hidden, common-term suppression enabled, and minimum mentions set to 5. The threshold applies to the sum in both directions on each edge. In **All connections**, setting it to 1 also admits related-only pairs. **Related entries** shows pairs with an explicit related-entry flag at any mention count. Node-type filters apply to neighbours and preserve the selection, so Agency can stay at the centre while only people surround it. The focused graph includes matching edges between neighbours. The sidebar lists immediate connections to the selection. [Filter logic](../web/data-model.js)

Node radii increase on a compressed scale with incoming mentions. Edge thickness increases in logarithmic bands with the two directions' combined mention count. A related-entry flag contributes zero text mentions. Edges touching the focused node receive more emphasis. [Canvas rendering](../web/graph-view.js)

## Article files

`web/data/articles/<id>.json` contains the title, original URL, publication text, ordered text blocks, bibliography blocks, related-entry list, original source TOC, and optional attribution from the JSONL snapshot. A paragraph can contain multiple linked spans, as in this invented example.

```json
{
  "kind": "p",
  "text": "Nietzsche discusses truth.",
  "links": [
    [0, 9, "nietzsche"],
    [20, 25, "truth"]
  ]
}
```

Offsets are half-open UTF-16 indices. Supported block kinds are `p`, `h2`, `h3`, `h4`, `li`, and `quote`. The current structured source emits paragraphs and headings. Bibliographies are preserved but do not contribute to counts. Reader navigation is built from actual section blocks, with the original source TOC retained in the data for inspection.

## Common-term filter

Any target mentioned in more than half of the source articles qualifies. Each source counts once for this cutoff, even if it mentions the target repeatedly. The browser removes text-mention counts **to** those targets. A reverse mention of a less common term or an explicit related-entry flag keeps the pair in the reduced graph. Nodes remain eligible for selection.

Incoming counts, node sizes, degree, and line weights use the complete or reduced graph chosen by this filter. Node-type and minimum-mention controls then determine which nodes and edges are displayed. This is why a node's global connection count can exceed the number of neighbours shown in its panel. The reader and passage evidence always use the complete source spans. The local build report lists the targets and corpus totals.

## Layout

The offline layout uses NumPy, a fixed random seed, weighted local grouping, edge attraction, pairwise repulsion, and group anchors. It uses connections after common-term suppression so ubiquitous vocabulary does not pull all articles into the centre. Attraction weights compress repeated mentions and include explicit related-entry links. The computed groups help position nodes. Display colours are chosen independently from estimated subject, node type, connection count, or a neutral palette. Changing filters can refit the camera while preserving the stored overview coordinates. [Layout calculation](../scripts/layout.py) · [Colour modes](../web/categories.js)

Selecting any node produces a deterministic radial neighbourhood with the strongest matching connections closest to the centre. **Show weaker connections** lowers the threshold to 1 while preserving the selection and node types.

## Reproducibility

The source hash, matching method, summary counts, ambiguous terms, unresolved related entries, and community summaries are recorded in `web/data/build-report.json`. The build does not fetch the encyclopedia or mutate the original datasets. To reproduce the primary graph, use the pinned dataset and Python dependencies. Downloaded and generated files stay outside Git.

## People, subject colours, and evidence

The People filter includes biographies and people mentioned without a biography. The biographies come from a reviewed list of entry IDs checked against titles and introductions. An article about a person's ideas can remain a topic. Unknown or duplicate IDs fail the build. [Biographical article IDs](../scripts/people.json)

Each article receives one estimated subject from keyword patterns in its title (weight 6), the first 1,600 characters of its introduction (weight 1), and its related-entry titles (weight 2). Ties follow the pattern order. A winning score below 2 yields **Other / interdisciplinary**. The inventory assigns subjects to additional nodes. A biography can have any subject. These estimates belong to the explorer. Connection-count colours use the node's global degree in the currently selected complete or reduced graph. [Subject classifier](../scripts/categories.py) · [Extra-node inventory](../scripts/extra_nodes.json)

Connection evidence groups stored target spans by sentence and shows explicit related-entry status separately. Two articles supply two directions. A keyword or person without an article has only incoming mentions, so evidence loads the one source article. Opening a passage scrolls to its source block and highlights the sentence and matching spans. These are lexical matches and do not establish influence or agreement. [Passage extraction](../web/evidence.js)

Full-text indexing is separate from graph matching, includes headings and bibliographies, and creates no graph edges. See [search](search.md).

## Additional people, keywords, and frequencies

The offline frequency scan counts alphabetic word tokens in preambles and main paragraphs. Internal apostrophes are retained. Each row records word frequency and distinct source-article count. The frequency scan excludes headings, numbers, and bibliographies. The separate full-text index covers a broader set of text. Its output stays local at `web/data/word-frequencies.json`. [Frequency builder](../scripts/extra_nodes.py)

Promotion to a node requires human review of the concept or person, a distinct title and aliases, and candidate matches in at least two articles. A person-focused topic can coexist with a separate person node when a dedicated biography is absent. The builder excludes candidates that duplicate existing titles or aliases or occur in too few articles. The full matcher applies longest-match and ambiguity rules to accepted candidates. The graph records final linked spans and `web/data/keyword-report.json` records candidate decisions and examples locally.

Every edge to an additional node originates in a real article. A keywords-only overview therefore contains nodes with no edges. Select a keyword and enable People or Topics to see which articles mention it and read their passages. The link audit gives examples of how a phrase becomes an alias, a separate node, or an exclusion. [Review decisions](link-audit.md#decisions-visible-in-the-graph)
