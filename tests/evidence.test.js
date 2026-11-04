import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evidenceDirections, passages } from "../web/evidence.js";
import { ArticleReader, readerParts } from "../web/reader.js";

test("evidence preserves UTF-16 offsets and combines repeated mentions in a sentence", () => {
  const text = "😀 Foucault discusses Foucault. Another sentence.";
  const article = {
    blocks: [
      { kind: "h2", text: "History", links: [] },
      {
        kind: "p",
        text,
        links: [
          [3, 11, "foucault"],
          [22, 30, "foucault"],
        ],
      },
    ],
  };
  const found = passages(article, "foucault");
  assert.equal(found.length, 1);
  assert.equal(found[0].section, "History");
  assert.equal(found[0].blockIndex, 1);
  assert.equal(text.slice(found[0].start, found[0].end), found[0].text);
  for (const [start, end] of found[0].links)
    assert.equal(found[0].text.slice(start, end), "Foucault");
  assert.equal(passages(article, "nietzsche").length, 0);
});

test("reader marks the exact evidence sentence and repeated mentions without changing links", () => {
  const text =
    "An earlier sentence. 😀 Foucault discusses Nietzsche and Foucault. Foucault appears later.";
  const links = [
    [24, 32, "foucault"],
    [43, 52, "nietzsche"],
    [57, 65, "foucault"],
    [67, 75, "foucault"],
  ];
  const block = { kind: "p", text, links };
  const found = passages({ blocks: [block] }, "foucault");
  assert.equal(found.length, 2);
  const passage = found[0];
  const highlight = {
    start: passage.start,
    end: passage.end,
    target: "foucault",
  };
  const parts = readerParts(block, highlight);
  const segments = parts.flatMap((part) => part.segments);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.equal(
    segments
      .filter((segment) => segment.highlight)
      .map((segment) => segment.text)
      .join(""),
    passage.text,
  );
  assert.deepEqual(
    segments
      .filter((segment) => segment.highlight === "reader-mention-highlight")
      .map((segment) => segment.text),
    ["Foucault", "Foucault"],
  );
  assert.deepEqual(
    parts
      .filter((part) => part.target)
      .map((part) => [
        part.target,
        part.segments.map((segment) => segment.text).join(""),
      ]),
    links.map(([start, end, target]) => [target, text.slice(start, end)]),
  );
  assert.ok(
    parts.some(
      (part) =>
        part.target === "nietzsche" &&
        part.segments[0].highlight === "reader-passage-highlight",
    ),
  );
  const last = parts.at(-2);
  assert.equal(last.target, "foucault");
  assert.equal(last.segments[0].highlight, null);
});

test("reader ignores invalid evidence bounds and clears marks without a highlight", () => {
  const block = {
    kind: "p",
    text: "😀 Foucault discusses truth.",
    links: [[3, 11, "foucault"]],
  };
  for (const highlight of [
    null,
    { start: -1, end: 20, target: "foucault" },
    { start: 0, end: 100, target: "foucault" },
    { start: 11, end: 3, target: "foucault" },
    { start: 0.5, end: 20, target: "foucault" },
    { start: 0, end: 20, target: "nietzsche" },
  ]) {
    assert.ok(
      readerParts(block, highlight)
        .flatMap((part) => part.segments)
        .every((segment) => segment.highlight === null),
    );
  }
});

test("reader requests navigation through callbacks without rendering or closing directly", async () => {
  const node = { id: "foucault", article: true };
  const highlight = { start: 3, end: 30, target: "foucault" };
  const requests = [];
  await ArticleReader.prototype.open.call(
    {
      onOpen(...args) {
        requests.push(args);
      },
      show() {
        assert.fail("History must control reader rendering.");
      },
    },
    node,
    4,
    highlight,
  );
  ArticleReader.prototype.close.call({
    onClose() {
      requests.push("close");
    },
    dismiss() {
      assert.fail("History must control dialog dismissal.");
    },
  });
  assert.deepEqual(requests, [[node, 4, highlight], "close"]);
});

test("evidence for a keyword or person without an article loads only the real source", async () => {
  const source = { id: "aesthetics", title: "Aesthetics", article: true };
  const keyword = { id: "keyword-music", title: "Music", article: false };
  const reads = [];
  const article = {
    blocks: [
      { kind: "p", text: "Music matters.", links: [[0, 5, keyword.id]] },
    ],
    related: [],
  };
  const reader = {
    async load(node) {
      assert.equal(node.article, true);
      reads.push(node.id);
      return article;
    },
  };
  const directions = await evidenceDirections(reader, keyword, source);
  assert.deepEqual(reads, [source.id]);
  assert.equal(directions.length, 1);
  assert.equal(directions[0].node.id, source.id);
  assert.equal(directions[0].destination.id, keyword.id);
  assert.equal(passages(directions[0].article, keyword.id).length, 1);
  reads.length = 0;
  const otherArticle = { ...source, id: "music-philosophy" };
  assert.equal(
    (await evidenceDirections(reader, source, otherArticle)).length,
    2,
  );
  assert.deepEqual(reads, [source.id, otherArticle.id]);
});

test("reader refuses synthetic article fetches and routes accidental opens to the network", async () => {
  const node = { id: "person-carl-jung", article: false };
  await assert.rejects(
    ArticleReader.prototype.load.call({}, node),
    /no article/,
  );
  const calls = [];
  await ArticleReader.prototype.open.call(
    {
      close() {
        calls.push("close");
      },
      onNavigate(id) {
        calls.push(id);
      },
    },
    node,
  );
  assert.deepEqual(calls, ["close", node.id]);
});

test("public reader reports an unavailable article without redirecting to login", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    status: 401,
    ok: false,
  }));
  await assert.rejects(
    ArticleReader.prototype.load.call(
      { cache: new Map() },
      { id: "foucault", article: true },
    ),
    /article file could not be loaded/,
  );
});

test("Homosexuality evidence accounts for every Foucault match in the corpus", async (t) => {
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
  const graph = JSON.parse(raw);
  const source = graph.nodes.findIndex((node) => node.id === "homosexuality");
  const target = graph.nodes.findIndex((node) => node.id === "foucault");
  const edge = graph.edges.find(
    (pair) =>
      pair[0] === Math.min(source, target) &&
      pair[1] === Math.max(source, target),
  );
  assert.ok(edge);
  const article = JSON.parse(
    await readFile(
      new URL("../web/data/articles/homosexuality.json", import.meta.url),
      "utf8",
    ),
  );
  const found = passages(article, "foucault");
  const count = found.reduce(
    (total, passage) => total + passage.links.length,
    0,
  );
  assert.equal(count, edge[source < target ? 2 : 3]);
  assert.ok(count > 0);
});
