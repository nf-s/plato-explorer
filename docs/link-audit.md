# Link audit

The review covers every article in the supplied snapshot. Article titles and introductions establish the identities under review. Occurrences in main paragraphs show which forms people actually use. The builder applies the same reviewed forms to graph counts, reader links, and passage evidence. [Article aliases](../scripts/aliases.json) · [Additional people and keywords](../scripts/extra_nodes.json) · [Ambiguity rules](../scripts/mention_rules.json)

## Decisions visible in the graph

These examples describe the project's curated matching rules.

| Target                       | Rule                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Meister Eckhart              | Link bare **Eckhart** to the biography.                                                                                                        |
| Shaftesbury                  | Accept short forms for the third earl. References identifying the first earl suppress ambiguous short forms in that source.                    |
| Edmund Burke                 | Accept **Burke** unless configured competing names occur in the source. The explicit full name remains eligible.                               |
| Joseph Addison and Carl Jung | Represent them as people without biographies. Suppress competing surnames, and exclude ambiguous phrases such as the publisher Addison-Wesley. |
| Dao and Daoism               | Match Dao/Tao to the keyword and Daoism/Taoism and Daoist/Taoist variants to the article. Exclude competing personal names.                    |
| Veganism                     | Group **veganism**, **vegan** and **vegans**.                                                                                                  |
| Anxiety and Depression       | Preserve separate nodes, review related forms and guard competing economic and physical senses.                                                |

The keyword review used corpus frequencies to nominate candidates, Wikipedia topic pages as supporting references and local passage checks to disambiguate meanings. Commit the resulting matching rules. Keep matched text, per-target counts, audit reports and review excerpts local.

Ambiguity rules trade coverage for precision. For example, a competing Burke in a bibliography suppresses bare **Burke** throughout the source, even when another paragraph concerns Edmund Burke. An article without a recognized blocker can still contain a false match. Longest-match rules and exclusions can remove previous links as well as add them. [Matching and span rules](data-model.md#mention-extraction)

## Repeat the check after a change

From the project root, preserve the current graph before editing the inventory or rules. Use a fresh output directory for each comparison.

```sh
mkdir -p .artifacts/next-link-review
cp web/data/graph.json .artifacts/next-link-review/baseline-graph.json
```

After editing, rebuild the graph and audit it against that copy.

```sh
.venv/bin/python scripts/build_data.py
python3 scripts/audit_links.py \
  --baseline .artifacts/next-link-review/baseline-graph.json \
  --data-dir web/data \
  --output .artifacts/next-link-review/link-audit.json
```

The audit checks each real article's stored links for valid targets, non-overlapping UTF-16 spans, intact character boundaries, paragraph scope, and self-mention exclusion. It compares every directed mention count and related-entry flag with the graph, then checks each node's incoming mentions, referring-article count, and degree. These checks establish that the graph reflects the stored annotations. Identity and sense still require passage review. [Audit implementation](../scripts/audit_links.py)

All aggregate counts use the complete corpus. The report limits its detailed lists to the largest 100 directional changes, up to ten original matched forms per changed node, and up to five current passage examples for selected targets. A graph-only baseline can establish a count delta. Establishing that one particular span changed requires the previous article annotations too.
