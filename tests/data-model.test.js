import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  commonTermIndices,
  connectionBetween,
  connections,
  createIndex,
  edgeMatches,
  searchArticles,
  validateArticle,
  validateGraph,
  visibleGraph,
  withoutCommonMentions,
} from "../web/data-model.js";

function fixture() {
  const nodes = [
    {
      id: "nietzsche",
      title: "Friedrich Nietzsche",
      aliases: ["Nietzsche"],
      mentions: 6,
      community: 0,
    },
    {
      id: "human-nature",
      title: "Human Nature",
      aliases: [],
      mentions: 3,
      community: 0,
    },
    {
      id: "descartes",
      title: "René Descartes",
      aliases: ["Descartes"],
      mentions: 0,
      community: 1,
    },
  ].map((node, i) => ({
    ...node,
    url: `https://plato.stanford.edu/entries/${node.id}/`,
    summary: "An introduction.",
    person: i !== 1,
    kind: i !== 1 ? "person" : "topic",
    article: true,
    subject: "Other / interdisciplinary",
    references: 1,
    degree: 2,
    x: i,
    y: i,
  }));
  return {
    version: 1,
    meta: {
      articles: 3,
      nodes: 3,
      connections: 2,
      mentions: 9,
      relatedLinks: 2,
      unresolvedRelated: 0,
    },
    nodes,
    communities: [
      { id: 0, label: "One", color: "#123456", count: 2 },
      { id: 1, label: "Two", color: "#abcdef", count: 1 },
    ],
    edges: [
      [0, 1, 3, 6, 0, 1],
      [0, 2, 0, 0, 1, 0],
    ],
  };
}

function syntheticFixture() {
  const graph = fixture();
  graph.nodes.push(
    {
      ...graph.nodes[0],
      id: "keyword-music",
      title: "Music",
      aliases: [],
      kind: "keyword",
      person: false,
      article: false,
      url: null,
      mentions: 5,
      references: 1,
      degree: 1,
    },
    {
      ...graph.nodes[0],
      id: "person-carl-jung",
      title: "Carl Jung",
      aliases: ["Jung"],
      kind: "person",
      person: true,
      article: false,
      url: null,
      mentions: 8,
      references: 1,
      degree: 1,
    },
  );
  graph.edges.push([0, 3, 5, 0, 0, 0], [1, 4, 8, 0, 0, 0]);
  graph.meta.nodes = 5;
  graph.meta.connections = 4;
  graph.meta.mentions = 22;
  graph.communities[0].count += 2;
  return graph;
}

test("incoming and outgoing counts reverse correctly from either endpoint", () => {
  const graph = fixture();
  const index = createIndex(graph);
  const filters = { type: "all", minimum: 1, community: null };
  const left = connections(graph, index, 0, filters)[0];
  const right = connections(graph, index, 1, filters)[0];
  assert.equal(left.outgoing, 3);
  assert.equal(left.incoming, 6);
  assert.equal(right.outgoing, 6);
  assert.equal(right.incoming, 3);
  assert.equal(left.weight, right.weight);
  assert.equal(left.relatedIn, true);
  assert.equal(right.relatedOut, true);
});

test("pair lookup preserves full mention counts and direction without applying graph filters", () => {
  const graph = fixture();
  graph.nodes[0].references = 2;
  const index = createIndex(graph);
  assert.deepEqual(
    connectionBetween(graph, index, "nietzsche", "human-nature"),
    {
      outgoing: 3,
      incoming: 6,
      relatedOut: false,
      relatedIn: true,
      weight: 9,
    },
  );
  assert.deepEqual(
    connectionBetween(graph, index, "human-nature", "nietzsche"),
    {
      outgoing: 6,
      incoming: 3,
      relatedOut: true,
      relatedIn: false,
      weight: 9,
    },
  );
});

test("pair lookup retains related-only connections and rejects absent endpoints and pairs", () => {
  const graph = fixture();
  const index = createIndex(graph);
  assert.deepEqual(connectionBetween(graph, index, "nietzsche", "descartes"), {
    outgoing: 0,
    incoming: 0,
    relatedOut: true,
    relatedIn: false,
    weight: 0,
  });
  assert.deepEqual(connectionBetween(graph, index, "descartes", "nietzsche"), {
    outgoing: 0,
    incoming: 0,
    relatedOut: false,
    relatedIn: true,
    weight: 0,
  });
  for (const [source, target] of [
    ["missing", "nietzsche"],
    ["nietzsche", "missing"],
    ["nietzsche", "nietzsche"],
    ["human-nature", "descartes"],
  ])
    assert.equal(connectionBetween(graph, index, source, target), null);
});

test("pair lookup counts mentions of synthetic nodes without inventing reverse mentions", () => {
  const graph = syntheticFixture();
  const index = createIndex(graph);
  assert.deepEqual(
    connectionBetween(graph, index, "nietzsche", "keyword-music"),
    {
      outgoing: 5,
      incoming: 0,
      relatedOut: false,
      relatedIn: false,
      weight: 5,
    },
  );
  assert.deepEqual(
    connectionBetween(graph, index, "keyword-music", "nietzsche"),
    {
      outgoing: 0,
      incoming: 5,
      relatedOut: false,
      relatedIn: false,
      weight: 5,
    },
  );
});

test("related-only connections survive the default filter and no mention counts are invented", () => {
  const edge = fixture().edges[1];
  assert.equal(edgeMatches(edge, { type: "all", minimum: 1 }), true);
  assert.equal(edgeMatches(edge, { type: "mentions", minimum: 1 }), false);
  assert.equal(edgeMatches(edge, { type: "all", minimum: 2 }), false);
  assert.equal(edgeMatches(edge, { type: "related", minimum: 50 }), true);
});

test("common-term filtering suppresses mentions by target while preserving related links and reverse mentions", () => {
  const graph = fixture();
  graph.nodes[0].references = 2;
  assert.deepEqual([...commonTermIndices(graph)], [0]);
  const filtered = withoutCommonMentions(graph);
  assert.deepEqual(filtered.edges, [
    [0, 1, 3, 0, 0, 1],
    [0, 2, 0, 0, 1, 0],
  ]);
  assert.equal(filtered.nodes[0].mentions, 0);
  assert.equal(filtered.nodes[1].mentions, 3);
  assert.equal(filtered.nodes[0].degree, 2);
  assert.equal(filtered.meta.mentions, 3);
  assert.equal(graph.edges[0][3], 6);
  assert.equal(graph.nodes[0].mentions, 6);
});

test("common-term filtering removes an empty pair without removing its articles", () => {
  const graph = fixture();
  graph.nodes[0].references = 2;
  graph.edges = [[0, 1, 0, 6, 0, 0]];
  const filtered = withoutCommonMentions(graph);
  assert.equal(filtered.edges.length, 0);
  assert.equal(filtered.nodes.length, graph.nodes.length);
});

test("focused view preserves the selected article when no edges match", () => {
  const graph = fixture();
  const index = createIndex(graph);
  assert.deepEqual(
    visibleGraph(graph, index, 0, {
      type: "mentions",
      minimum: 10,
      community: null,
    }),
    { nodes: [0], edges: [] },
  );
  assert.deepEqual(
    visibleGraph(graph, index, null, { type: "all", minimum: 1, community: 1 }),
    { nodes: [2], edges: [] },
  );
});

test("search supports surnames, accents, and partial concept titles", () => {
  const graph = fixture();
  const index = createIndex(graph);
  assert.deepEqual(searchArticles(graph, index, "nietzsche"), [0]);
  assert.deepEqual(searchArticles(graph, index, "rene descartes"), [2]);
  assert.deepEqual(searchArticles(graph, index, "nature"), [1]);
  assert.deepEqual(searchArticles(graph, index, "unfindable"), []);
});

test("people filter excludes topics from overview and neighbors but preserves the selected topic", () => {
  const graph = fixture();
  const index = createIndex(graph);
  const filters = {
    type: "all",
    minimum: 1,
    community: null,
    kinds: { person: true, topic: false, keyword: false },
  };
  assert.deepEqual(visibleGraph(graph, index, null, filters).nodes, [0, 2]);
  assert.deepEqual(
    connections(graph, index, 0, filters).map((connection) => connection.index),
    [2],
  );
  assert.deepEqual(visibleGraph(graph, index, 1, filters), {
    nodes: [1, 0],
    edges: [graph.edges[0]],
  });
  assert.deepEqual(searchArticles(graph, index, "nature", 12, true), []);
  assert.deepEqual(searchArticles(graph, index, "nietzsche", 12, true), [0]);
});

test("node types filter independently and retain a selected topic or hidden keyword", () => {
  const graph = syntheticFixture();
  const index = createIndex(graph);
  const filters = {
    type: "all",
    minimum: 1,
    community: null,
    kinds: { person: true, topic: false, keyword: false },
  };
  assert.deepEqual(visibleGraph(graph, index, null, filters).nodes, [0, 2, 4]);
  assert.deepEqual(visibleGraph(graph, index, 1, filters).nodes, [1, 0, 4]);
  assert.deepEqual(visibleGraph(graph, index, 3, filters).nodes, [3, 0]);
  filters.kinds = { person: false, topic: false, keyword: true };
  assert.deepEqual(visibleGraph(graph, index, null, filters).nodes, [3]);
  filters.kinds.keyword = false;
  assert.deepEqual(visibleGraph(graph, index, 1, filters), {
    nodes: [1],
    edges: [],
  });
  assert.equal(
    graph.nodes[searchArticles(graph, index, "Jung")[0]].id,
    "person-carl-jung",
  );
  assert.equal(
    graph.nodes[searchArticles(graph, index, "music")[0]].id,
    "keyword-music",
  );
});

test("synthetic nodes cannot masquerade as articles or emit source links", () => {
  assert.equal(validateGraph(syntheticFixture()).meta.articles, 3);
  for (const mutate of [
    (graph) => {
      graph.nodes[3].url = "https://plato.stanford.edu/entries/music/";
    },
    (graph) => {
      graph.nodes[3].person = true;
    },
    (graph) => {
      graph.nodes[3].kind = "topic";
    },
    (graph) => {
      graph.nodes[3].article = true;
    },
    (graph) => {
      graph.meta.nodes = 4;
    },
    (graph) => {
      graph.meta.articles = 4;
    },
    (graph) => {
      graph.edges[2][3] = 1;
    },
    (graph) => {
      graph.edges[2][4] = 1;
    },
    (graph) => {
      graph.edges[2] = [3, 4, 5, 0, 0, 0];
    },
  ]) {
    const graph = syntheticFixture();
    mutate(graph);
    assert.throws(() => validateGraph(graph));
  }
});

test("common-term frequency uses source article count rather than total graph nodes", () => {
  const graph = syntheticFixture();
  graph.nodes[3].references = 2;
  assert.deepEqual([...commonTermIndices(graph)], [3]);
});

test("graph boundaries reject bad URLs, coordinates, duplicates and dangling connections", () => {
  assert.equal(validateGraph(fixture()).nodes.length, 3);
  const foreign = fixture();
  foreign.nodes[0].url = "javascript:alert(1)";
  assert.throws(() => validateGraph(foreign), /invalid article/);
  const missing = fixture();
  missing.edges[0][1] = 999;
  assert.throws(() => validateGraph(missing), /invalid connection/);
  const duplicate = fixture();
  duplicate.edges[1] = duplicate.edges[0];
  assert.throws(() => validateGraph(duplicate), /duplicate/);
  const nan = fixture();
  nan.nodes[0].x = NaN;
  assert.throws(() => validateGraph(nan), /invalid article/);
});

test("article boundaries reject out-of-range or unknown mention links", () => {
  const article = {
    id: "nietzsche",
    title: "Friedrich Nietzsche",
    url: "https://plato.stanford.edu/entries/nietzsche/",
    blocks: [{ kind: "p", text: "Nature", links: [[0, 6, "human-nature"]] }],
    bibliography: [],
    related: [],
  };
  const ids = new Set(["nietzsche", "human-nature"]);
  assert.equal(validateArticle(article, "nietzsche", ids).blocks.length, 1);
  article.blocks[0].links[0][1] = 10;
  assert.throws(
    () => validateArticle(article, "nietzsche", ids),
    /Invalid article link/,
  );
  article.blocks[0].links[0] = [0, 6, "missing"];
  assert.throws(
    () => validateArticle(article, "nietzsche", ids),
    /Invalid article link/,
  );
});

test("built encyclopedia has consistent totals and a working Nietzsche alias", async (t) => {
  let raw;
  try {
    raw = await readFile(
      new URL("../web/data/graph.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return t.skip("Build the dataset to run the corpus check.");
    throw error;
  }
  const graph = validateGraph(JSON.parse(raw));
  const totals = graph.nodes.map(() => 0);
  let mentions = 0;
  let related = 0;
  for (const [
    a,
    b,
    forward,
    backward,
    relatedForward,
    relatedBackward,
  ] of graph.edges) {
    totals[a] += backward;
    totals[b] += forward;
    mentions += forward + backward;
    related += relatedForward + relatedBackward;
  }
  graph.nodes.forEach((node, i) =>
    assert.equal(node.mentions, totals[i], node.id),
  );
  assert.equal(mentions, graph.meta.mentions);
  assert.equal(related, graph.meta.relatedLinks);
  const index = createIndex(graph);
  assert.equal(
    graph.nodes[searchArticles(graph, index, "Nietzsche")[0]].id,
    "nietzsche",
  );
});
