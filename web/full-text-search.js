import { normalize } from "./data-model.js";

const SHARDS = 128;
const encoder = new TextEncoder();

export function searchWords(text) {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function shardFor(term) {
  let value = 2166136261;
  for (const byte of encoder.encode(term))
    value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value % SHARDS;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateManifest(data, graph) {
  const articles = graph.nodes.filter((node) => node.article);
  if (
    !record(data) ||
    data.version !== 1 ||
    data.shards !== SHARDS ||
    !Array.isArray(data.ids) ||
    !Array.isArray(data.lengths) ||
    data.ids.length !== articles.length ||
    data.lengths.length !== articles.length ||
    articles.some((node, index) => node.id !== graph.nodes[index].id) ||
    data.ids.some((id, index) => id !== articles[index].id) ||
    data.lengths.some(
      (length) => !Number.isSafeInteger(length) || length < 1,
    ) ||
    !Number.isFinite(data.averageLength) ||
    data.averageLength <= 0
  )
    throw new Error(
      "The full-text index does not match this article snapshot. Rebuild the search index.",
    );
  const average =
    data.lengths.reduce((sum, value) => sum + value, 0) / data.lengths.length;
  if (Math.abs(average - data.averageLength) > 0.001)
    throw new Error("Invalid full-text index statistics.");
  return data;
}

export function validateShard(data, expected, manifest) {
  if (
    !record(data) ||
    data.version !== 1 ||
    data.shard !== expected ||
    !record(data.terms)
  )
    throw new Error("Invalid full-text index shard.");
  for (const [term, postings] of Object.entries(data.terms)) {
    if (
      !term ||
      searchWords(term).length !== 1 ||
      searchWords(term)[0] !== term ||
      shardFor(term) !== expected ||
      !Array.isArray(postings) ||
      !postings.length ||
      postings.length % 2
    )
      throw new Error("Invalid full-text term.");
    let previous = -1;
    for (let i = 0; i < postings.length; i += 2) {
      const index = postings[i];
      const frequency = postings[i + 1];
      if (
        !Number.isSafeInteger(index) ||
        index <= previous ||
        index >= manifest.ids.length ||
        !Number.isSafeInteger(frequency) ||
        frequency < 1 ||
        frequency > manifest.lengths[index]
      )
        throw new Error("Invalid full-text postings.");
      previous = index;
    }
  }
  return data.terms;
}

export function rankMatches(postings, terms, manifest, graph) {
  if (!postings.length || postings.some((list) => !list.length)) return [];
  const ordered = [...postings].sort((a, b) => a.length - b.length);
  const candidates = new Set();
  for (let i = 0; i < ordered[0].length; i += 2) candidates.add(ordered[0][i]);
  const scores = new Map([...candidates].map((index) => [index, 0]));
  for (const list of ordered) {
    const seen = new Set();
    const idf = Math.log(
      1 +
        (manifest.ids.length - list.length / 2 + 0.5) / (list.length / 2 + 0.5),
    );
    for (let i = 0; i < list.length; i += 2) {
      const index = list[i];
      if (!candidates.has(index)) continue;
      seen.add(index);
      const frequency = list[i + 1];
      const lengthFactor =
        1.2 *
        (0.25 + (0.75 * manifest.lengths[index]) / manifest.averageLength);
      scores.set(
        index,
        scores.get(index) +
          (idf * frequency * 2.2) / (frequency + lengthFactor),
      );
    }
    for (const index of candidates)
      if (!seen.has(index)) candidates.delete(index);
  }
  return [...candidates]
    .map((index) => {
      const titleWords = new Set(searchWords(graph.nodes[index].title));
      const titleMatches = terms.filter((term) => titleWords.has(term)).length;
      return {
        index,
        score:
          scores.get(index) +
          2 * titleMatches +
          (titleMatches === terms.length ? 4 : 0),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        graph.nodes[a.index].title.localeCompare(graph.nodes[b.index].title),
    );
}

function matchingSpans(text, terms) {
  const found = [];
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if (terms.has(normalize(match[0])))
      found.push([match.index, match.index + match[0].length]);
  }
  return found;
}

export function excerpt(article, terms) {
  const wanted = new Set(terms);
  let section = "Introduction";
  let best = null;
  const blocks = [
    ...article.blocks.map((block, blockIndex) => ({
      ...block,
      blockIndex,
      bibliography: false,
    })),
    ...article.bibliography.map((block) => ({
      ...block,
      blockIndex: null,
      bibliography: true,
    })),
  ];
  for (const block of blocks) {
    if (block.bibliography) section = "Bibliography";
    else if (block.kind.startsWith("h")) section = block.text;
    const spans = matchingSpans(block.text, wanted);
    if (!spans.length) continue;
    const unique = new Set(
      spans.map(([start, end]) => normalize(block.text.slice(start, end))),
    );
    const score =
      unique.size * 100 +
      Math.min(spans.length, 20) -
      (block.kind.startsWith("h") ? 1 : 0);
    if (!best || score > best.score)
      best = {
        text: block.text,
        spans,
        score,
        section,
        blockIndex: block.blockIndex,
      };
  }
  if (!best)
    return {
      snippet: article.title,
      highlights: matchingSpans(article.title, wanted),
      blockIndex: null,
      section: "Title",
    };
  let from = Math.max(0, best.spans[0][0] - 80);
  let to = Math.min(best.text.length, from + 300);
  while (from > 0 && /[\p{L}\p{N}\p{M}]/u.test(best.text[from - 1])) from -= 1;
  while (to < best.text.length && /[\p{L}\p{N}\p{M}]/u.test(best.text[to]))
    to += 1;
  const prefix = from ? "…" : "";
  const highlights = best.spans
    .filter(([start, end]) => start >= from && end <= to)
    .map(([start, end]) => [
      start - from + prefix.length,
      end - from + prefix.length,
    ]);
  return {
    snippet:
      prefix + best.text.slice(from, to) + (to < best.text.length ? "…" : ""),
    highlights,
    blockIndex: best.blockIndex,
    section: best.section,
  };
}

export class FullTextSearch {
  constructor(graph, reader) {
    this.graph = graph;
    this.reader = reader;
    this.articleCount = graph.nodes.filter((node) => node.article).length;
    this.manifest = null;
    this.shards = new Map();
  }

  async json(path, signal) {
    const response = await fetch(`./data/search/${path}`, { signal });
    if (response.status === 401)
      throw new Error("Your session expired. Reload to sign in again.");
    if (!response.ok)
      throw new Error(
        "The full-text index could not be loaded. Rebuild it with scripts/build_search.py.",
      );
    return response.json();
  }

  async search(query, { signal, limit = 8, offset = 0 } = {}) {
    signal?.throwIfAborted();
    if (typeof query !== "string" || query.length > 200)
      throw new Error("Use a search of 200 characters or fewer.");
    const terms = [...new Set(searchWords(query))];
    if (terms.length > 12)
      throw new Error("Use no more than 12 different search words.");
    if (!terms.length) return { results: [], total: 0, terms };
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("Invalid full-text result limit.");
    if (!Number.isInteger(offset) || offset < 0 || offset > this.articleCount)
      throw new Error("Invalid full-text result offset.");
    if (!this.manifest)
      this.manifest = validateManifest(
        await this.json("manifest.json", signal),
        this.graph,
      );
    const manifest = this.manifest;
    const requested = [...new Set(terms.map(shardFor))];
    const loaded = new Map(
      await Promise.all(
        requested.map(async (shard) => {
          let data = this.shards.get(shard);
          if (!data) {
            data = validateShard(
              await this.json(`${String(shard).padStart(3, "0")}.json`, signal),
              shard,
              manifest,
            );
            signal?.throwIfAborted();
            if (this.shards.size >= 24)
              this.shards.delete(this.shards.keys().next().value);
            this.shards.set(shard, data);
          }
          return [shard, data];
        }),
      ),
    );
    signal?.throwIfAborted();
    const postings = terms.map((term) => {
      const shard = loaded.get(shardFor(term));
      return Object.hasOwn(shard, term) ? shard[term] : [];
    });
    const ranked = rankMatches(postings, terms, manifest, this.graph);
    const results = await Promise.all(
      ranked.slice(offset, offset + limit).map(async (match) => {
        const article = await this.reader.load(
          this.graph.nodes[match.index],
          signal,
        );
        signal?.throwIfAborted();
        return { ...match, ...excerpt(article, terms) };
      }),
    );
    signal?.throwIfAborted();
    return { results, total: ranked.length, terms };
  }
}
