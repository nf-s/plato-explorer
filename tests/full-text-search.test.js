import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FullTextSearch,
  excerpt,
  rankMatches,
  searchWords,
  shardFor,
  validateManifest,
  validateShard,
} from "../web/full-text-search.js";

function fixture() {
  const graph = {
    nodes: [
      { id: "ethics", title: "Ethics", article: true },
      { id: "justice", title: "Justice", article: true },
      { id: "cafe", title: "Café", article: true },
    ],
  };
  const manifest = {
    version: 1,
    shards: 128,
    ids: ["ethics", "justice", "cafe"],
    lengths: [20, 20, 20],
    averageLength: 20,
  };
  return { graph, manifest };
}

test("full-text terms use whole Unicode words and ignore case, accents and punctuation", () => {
  assert.deepEqual(searchWords("René’s CAFÉ, φιλοσοφία / 𝕏_2"), [
    "rene",
    "s",
    "cafe",
    "φιλοσοφια",
    "x",
    "2",
  ]);
  assert.deepEqual(searchWords("ﬁ Café\u0301"), ["fi", "cafe"]);
  assert.equal(shardFor("justice"), 98);
  assert.equal(shardFor("cafe"), 72);
  assert.equal(shardFor("漢字"), 114);
});

test("ranking requires every word but permits different paragraphs; title matches receive a boost", () => {
  const { graph, manifest } = fixture();
  const result = rankMatches(
    [
      [0, 3, 1, 1, 2, 4],
      [0, 2, 1, 1],
    ],
    ["justice", "freedom"],
    manifest,
    graph,
  );
  assert.deepEqual(
    result.map((match) => match.index),
    [1, 0],
  );
  assert.deepEqual(
    rankMatches([[0, 3], []], ["justice", "unknown"], manifest, graph),
    [],
  );
});

test("index validation rejects stale snapshots, unknown IDs, invalid frequencies and duplicate postings", () => {
  const { graph, manifest } = fixture();
  assert.equal(validateManifest(manifest, graph), manifest);
  assert.throws(
    () =>
      validateManifest(
        { ...manifest, ids: ["other", "justice", "cafe"] },
        graph,
      ),
    /does not match/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, averageLength: 25 }, graph),
    /statistics/,
  );
  const shard = shardFor("justice");
  assert.deepEqual(
    validateShard(
      { version: 1, shard, terms: { justice: [0, 2, 1, 1] } },
      shard,
      manifest,
    ),
    { justice: [0, 2, 1, 1] },
  );
  for (const postings of [[3, 1], [0, 21], [0, 1, 0, 1], [0, 0], [0]]) {
    assert.throws(
      () =>
        validateShard(
          { version: 1, shard, terms: { justice: postings } },
          shard,
          manifest,
        ),
      /Invalid/,
    );
  }
});

test("full-text manifest excludes synthetic nodes while preserving actual article indices", () => {
  const { graph, manifest } = fixture();
  graph.nodes.push(
    { id: "person-carl-jung", title: "Carl Jung", article: false },
    { id: "keyword-justice", title: "Justice", article: false },
  );
  assert.equal(validateManifest(manifest, graph), manifest);
  const ranked = rankMatches([[1, 2]], ["justice"], manifest, graph);
  assert.deepEqual(
    ranked.map((match) => graph.nodes[match.index].id),
    ["justice"],
  );
  const expanded = {
    ...manifest,
    ids: [...manifest.ids, "person-carl-jung"],
    lengths: [...manifest.lengths, 20],
  };
  assert.throws(() => validateManifest(expanded, graph), /does not match/);
  const reordered = {
    ...graph,
    nodes: [graph.nodes[3], ...graph.nodes.slice(0, 3), graph.nodes[4]],
  };
  assert.throws(() => validateManifest(manifest, reordered), /does not match/);
});

test("excerpts preserve UTF-16 highlight offsets, section locations, and bibliography matches", () => {
  const article = {
    title: "Ethics",
    blocks: [
      { kind: "h2", text: "2. Examples" },
      {
        kind: "p",
        text: "🧠 A café discusses René and justice. Justice matters.",
      },
    ],
    bibliography: [{ kind: "p", text: "René, 2020. Uncommonvolume, Paris." }],
  };
  const result = excerpt(article, ["cafe", "rene"]);
  assert.equal(result.blockIndex, 1);
  assert.equal(result.section, "2. Examples");
  assert.deepEqual(
    result.highlights.map(([start, end]) => result.snippet.slice(start, end)),
    ["café", "René"],
  );
  const bibliography = excerpt(article, ["uncommonvolume"]);
  assert.equal(bibliography.section, "Bibliography");
  assert.equal(bibliography.blockIndex, null);
  assert.equal(
    bibliography.snippet.slice(...bibliography.highlights[0]),
    "Uncommonvolume",
  );
  assert.equal(excerpt(article, ["ethics"]).section, "Title");
});

test("full-text search fetches only needed shards, caps article reads and caches the index", async (t) => {
  const { graph, manifest } = fixture();
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(url);
    return Response.json(
      url.endsWith("manifest.json")
        ? manifest
        : {
            version: 1,
            shard: shardFor("justice"),
            terms: { justice: [0, 2, 1, 1, 2, 1] },
          },
    );
  });
  const reads = [];
  const reader = {
    async load(node) {
      reads.push(node.id);
      return {
        title: node.title,
        blocks: [{ kind: "p", text: "Justice in the main article." }],
        bibliography: [],
      };
    },
  };
  const search = new FullTextSearch(graph, reader);
  const first = await search.search("justice", { limit: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.results.length, 1);
  assert.equal(reads.length, 1);
  assert.equal(first.results[0].index, 1);
  const second = await search.search("JUSTICE", { limit: 1, offset: 1 });
  assert.notEqual(second.results[0].index, first.results[0].index);
  assert.equal(second.total, first.total);
  assert.equal(requested.length, 2);
  assert.equal(reads.length, 2);
  await assert.rejects(search.search("a ".repeat(101)), /200 characters/);
  await assert.rejects(search.search("justice", { offset: -1 }), /offset/);
  await assert.rejects(
    search.search(
      "one two three four five six seven eight nine ten eleven twelve thirteen",
    ),
    /12 different/,
  );
});

test("cancelled searches do not return stale excerpts, including cached-index searches", async () => {
  const { graph, manifest } = fixture();
  const controller = new AbortController();
  const reader = {
    async load(node) {
      controller.abort();
      return { title: node.title, blocks: [], bibliography: [] };
    },
  };
  const search = new FullTextSearch(graph, reader);
  search.manifest = manifest;
  search.shards.set(shardFor("justice"), { justice: [0, 1] });
  await assert.rejects(
    search.search("justice", { signal: controller.signal }),
    { name: "AbortError" },
  );
  await assert.rejects(
    search.search("justice", { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("generated index finds a term in an article's main text with no title match", async (t) => {
  let raw;
  try {
    raw = await readFile(
      new URL("../web/data/search/manifest.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return t.skip("Build the full-text index first.");
    throw error;
  }
  const graph = JSON.parse(
    await readFile(new URL("../web/data/graph.json", import.meta.url), "utf8"),
  );
  const manifest = validateManifest(JSON.parse(raw), graph);
  const query = "panopticon";
  const shard = shardFor(query);
  const data = validateShard(
    JSON.parse(
      await readFile(
        new URL(
          `../web/data/search/${String(shard).padStart(3, "0")}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    shard,
    manifest,
  );
  const ranked = rankMatches([data[query]], [query], manifest, graph);
  const foucault = ranked.find(
    (match) => graph.nodes[match.index].id === "foucault",
  );
  assert.ok(
    foucault,
    "Michel Foucault should match Panopticon in his article text",
  );
  assert.equal(
    graph.nodes[foucault.index].title.toLowerCase().includes(query),
    false,
  );
  const article = JSON.parse(
    await readFile(
      new URL("../web/data/articles/foucault.json", import.meta.url),
      "utf8",
    ),
  );
  const passage = excerpt(article, [query]);
  assert.ok(passage.highlights.length > 0);
  assert.ok(passage.blockIndex !== null);
});
