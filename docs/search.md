# Full-text search

The search box returns two kinds of results. **Nodes** searches titles and aliases in the loaded graph and opens the selected node's neighbourhood. **Article text** searches every article in the local build and opens a matching article at its excerpt. Both searches work across People, Topics, and Keywords filter settings. For example, **Jung** can find the Carl Jung node and articles citing other authors named Jung. Bibliography text is searchable even when its names do not produce graph edges. [Search interface](../web/app.js) · [Graph title matching](../web/data-model.js)

## Build and query

Run `python3 scripts/build_search.py` after rebuilding article data. It indexes the title, all text blocks including headings, and bibliography of each node with `article: true`. A keyword or alias can appear in these results whenever the words occur in an article. Adding it to the graph inventory does not add searchable article text. [Index builder](../scripts/build_search.py)

A query can contain up to 200 characters and 12 distinct words. Search normalizes case and accents, treats punctuation as a separator, and requires every query word somewhere in the article. Quoted phrases use the same rules. Word order, stemming, and synonyms play no part in matching. Ranking combines BM25 term frequency and document length with a title-match boost. An excerpt shows a relevant block from each result. When query words occur in different blocks, one excerpt may contain only a subset.

## Requests and row reads

Public Cloudflare Pages serves the graph, search index, and article text as static files. A query issues **zero D1 reads**, regardless of the number of matches. The UI waits 250 ms after typing before starting full-text retrieval and cancels superseded requests. The browser loads the manifest once, fetches only the shards needed for the query, and keeps up to 24 shards in memory. It then loads article JSON for the displayed page of eight excerpts, sharing the reader's 12-article cache. **Show more results** loads the next page. The separate private Worker can incur session and access-control reads for protected requests. [Retrieval and cache limits](../web/full-text-search.js) · [Public deployment](public-deployment.md) · [Private deployment](deployment.md)

## Index contract

`web/data/search/manifest.json` contains the ordered article IDs, their token lengths, mean document length, and shard count. Its IDs match the actual-article prefix of the graph, which lets search results use the same indices as the reader. The 128 numbered shards map each normalized word to sorted `[articleIndex, termFrequency]` pairs, stored as a flat list. FNV-1a over the UTF-8 word chooses the shard. The client validates manifest order, lengths, shard ownership, postings order, and frequency bounds. The manifest and shards are generated locally and excluded from Git.

`FullTextSearch.search(query, { signal, limit, offset })` returns `{ results, total, terms }`. Each result contains its index, score, snippet, UTF-16 highlight spans relative to the snippet, section, and block index. The reader opens a numeric block index, the bibliography when the section equals `Bibliography`, or the article start for a title-only match. [Search tests](../tests/full-text-search.test.js)
