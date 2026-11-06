import assert from "node:assert/strict";
import test from "node:test";
import { ArticlePreview, articleExcerpt } from "../web/article-preview.js";

class TestElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.isConnected = true;
    this.offsetWidth = 380;
    this.offsetHeight = 300;
    this.text = "";
  }

  set textContent(value) {
    this.text = value;
    this.children = [];
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.text = "";
    this.append(...children);
  }

  contains(target) {
    return (
      target === this || this.children.some((child) => child.contains(target))
    );
  }

  closest(selector) {
    if (
      selector === "a[data-article]" &&
      this.tag === "a" &&
      this.dataset.article
    )
      return this;
    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (selector === `.${child.className}`) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, properties = {}) {
    const event = {
      target: this,
      relatedTarget: null,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.propagationStopped = true;
      },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
      if (event.propagationStopped) break;
    }
    return event;
  }

  focus() {
    const previous = document.activeElement;
    if (previous === this) return;
    document.activeElement = this;
    for (let node = previous; node; node = node.parent)
      node.emit("focusout", { target: previous, relatedTarget: this });
    for (let node = this; node; node = node.parent)
      node.emit("focusin", { target: this, relatedTarget: previous });
  }

  getBoundingClientRect() {
    return { left: 100, top: 100, bottom: 120 };
  }
}

function article(text) {
  return { blocks: [{ kind: "p", text }], attribution: null };
}

function fixture(t, load = (node) => Promise.resolve(article(node.title))) {
  const original = new Map(
    ["Element", "document", "window"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const document = new TestElement();
  document.createElement = (tag) => new TestElement(tag);
  document.activeElement = null;
  const window = new TestElement();
  window.innerWidth = 1200;
  window.innerHeight = 900;
  Object.assign(globalThis, { Element: TestElement, document, window });
  const dialog = new TestElement("dialog");
  dialog.open = true;
  const content = new TestElement();
  const scroll = new TestElement();
  scroll.className = "reader-article";
  scroll.append(content);
  dialog.append(scroll);
  const nodes = ["source", "first", "second", "keyword"].map((id) => ({
    id,
    title: id,
    aliases: [],
    article: id !== "keyword",
    summary: `${id} summary`,
  }));
  const anchors = new Map(
    nodes.slice(1).map((node) => {
      const anchor = new TestElement("a");
      anchor.dataset.article = node.id;
      content.append(anchor);
      return [node.id, anchor];
    }),
  );
  const loads = [];
  const reader = {
    graph: {
      nodes,
      edges: [
        [0, 1, 3, 1, 0, 1],
        [0, 2, 2, 0, 0, 0],
        [0, 3, 4, 0, 0, 0],
      ],
    },
    dialog,
    content,
    currentLocation: () => ({ id: "source" }),
    load(node, signal) {
      loads.push({ node, signal });
      return load(node, signal);
    },
  };
  const preview = new ArticlePreview(reader);
  t.after(() => {
    preview.hide();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { preview, reader, anchors, loads, document, window, scroll };
}

function pointer(anchor, overrides = {}) {
  return {
    target: anchor,
    pointerType: "mouse",
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 100,
    clientY: 100,
    ...overrides,
  };
}

test("excerpts use opening prose, skip empty blocks and headings, and bound long text", () => {
  assert.equal(
    articleExcerpt({
      blocks: [
        { kind: "h2", text: "Introduction" },
        { kind: "p", text: "  " },
        { kind: "quote", text: " Opening passage. " },
        { kind: "p", text: "Later passage." },
      ],
    }),
    "Opening passage.",
  );
  assert.equal(articleExcerpt({ blocks: [] }, "Summary."), "Summary.");
  assert.equal(articleExcerpt({ blocks: [] }), "");
  const text = "A complete word. ".repeat(50);
  const excerpt = articleExcerpt(article(text));
  assert.ok(excerpt.length <= 481);
  assert.ok(excerpt.endsWith("…"));
  assert.ok(text.startsWith(excerpt.slice(0, -1)));
  assert.equal(articleExcerpt(article("x".repeat(700))), `${"x".repeat(480)}…`);
});

test("hover waits before loading and leaving a link cancels the pending preview", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { preview, reader, anchors, loads } = fixture(t);
  const event = pointer(anchors.get("first"));
  reader.content.emit("pointerover", event);
  t.mock.timers.tick(549);
  assert.equal(loads.length, 0);
  reader.content.emit("pointerout", event);
  t.mock.timers.tick(1000);
  assert.equal(loads.length, 0);
  assert.equal(preview.card.hidden, true);
  reader.content.emit("pointerover", event);
  t.mock.timers.tick(550);
  await Promise.resolve();
  assert.deepEqual(
    loads.map(({ node }) => node.id),
    ["first"],
  );
  assert.equal(preview.card.hidden, false);
});

test("touch hover, short presses and movement outside the reader do not load previews", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { reader, anchors, loads, document } = fixture(t);
  const event = pointer(anchors.get("first"), { pointerType: "touch" });
  reader.content.emit("pointerover", event);
  t.mock.timers.tick(600);
  reader.content.emit("pointerdown", event);
  t.mock.timers.tick(200);
  document.emit("pointerup", event);
  t.mock.timers.tick(600);
  reader.content.emit("pointerdown", event);
  document.emit("pointermove", { ...event, target: document, clientX: 130 });
  t.mock.timers.tick(600);
  assert.equal(loads.length, 0);
});

test("a held link opens a pinned preview and consumes only the release click", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { preview, reader, anchors, document } = fixture(t);
  const event = pointer(anchors.get("first"));
  reader.content.emit("pointerdown", event);
  t.mock.timers.tick(550);
  await Promise.resolve();
  assert.equal(preview.card.hidden, false);
  assert.equal(document.emit("pointerup", event).defaultPrevented, true);
  const releaseClick = reader.content.emit("click", event);
  assert.equal(releaseClick.defaultPrevented, true);
  assert.equal(releaseClick.propagationStopped, true);
  reader.content.emit("pointerout", event);
  t.mock.timers.tick(1000);
  assert.equal(preview.card.hidden, false);
  const nextClick = reader.content.emit("click", event);
  assert.equal(nextClick.defaultPrevented, false);
  assert.equal(preview.card.hidden, true);
});

test("ordinary text and links retain their native context menu", (t) => {
  const { reader, anchors } = fixture(t);
  assert.equal(reader.content.emit("contextmenu").defaultPrevented, false);
  assert.equal(
    reader.content.emit("contextmenu", {
      target: anchors.get("first"),
    }).defaultPrevented,
    false,
  );
});

test("a hold without a release click does not consume subsequent keyboard activation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { preview, reader, anchors, document } = fixture(t);
  const event = pointer(anchors.get("first"), { pointerType: "touch" });
  reader.content.emit("pointerdown", event);
  t.mock.timers.tick(550);
  await Promise.resolve();
  document.emit("pointerup", event);
  preview.hide(true);
  const keyboardClick = reader.content.emit("click", { ...event, detail: 0 });
  assert.equal(keyboardClick.defaultPrevented, false);
  assert.equal(keyboardClick.propagationStopped, false);
});

test("keyboard dismissal restores the link without reopening the preview or closing the reader", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { preview, reader, anchors, loads, document, window } = fixture(t);
  const anchor = anchors.get("first");
  anchor.focus();
  const open = reader.content.emit("keydown", {
    target: anchor,
    key: "ArrowDown",
  });
  await Promise.resolve();
  assert.equal(open.defaultPrevented, true);
  assert.equal(document.activeElement, preview.card);
  const escape = reader.dialog.emit("keydown", {
    target: preview.card,
    key: "Escape",
  });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(document.activeElement, anchor);
  t.mock.timers.tick(1000);
  assert.equal(preview.card.hidden, true);
  assert.equal(loads.length, 1);
  assert.equal(reader.dialog.open, true);
  await preview.show(anchor, true);
  preview.card.focus();
  window.emit("resize");
  assert.equal(document.activeElement, anchor);
  t.mock.timers.tick(1000);
  assert.equal(preview.card.hidden, true);
  assert.equal(loads.length, 2);
});

test("replaced and dismissed loads cannot update or reopen the preview", async (t) => {
  const pending = new Map();
  const { preview, anchors, loads } = fixture(
    t,
    (node) =>
      new Promise((resolve) => {
        pending.set(node.id, resolve);
      }),
  );
  const first = preview.show(anchors.get("first"));
  const second = preview.show(anchors.get("second"));
  assert.equal(loads[0].signal.aborted, true);
  pending.get("second")(article("Second introduction."));
  await second;
  pending.get("first")(article("Stale first introduction."));
  await first;
  assert.equal(
    preview.card.querySelector(".article-preview-excerpt").textContent,
    "Second introduction.",
  );
  const dismissed = preview.show(anchors.get("first"));
  preview.hide();
  assert.equal(loads[2].signal.aborted, true);
  pending.get("first")(article("Dismissed introduction."));
  await dismissed;
  assert.equal(preview.card.hidden, true);
  assert.equal(
    preview.card.querySelector(".article-preview-excerpt").textContent,
    "",
  );
});

test("synthetic targets offer connection information without requesting an article", async (t) => {
  const { preview, anchors, loads } = fixture(t);
  await preview.show(anchors.get("keyword"));
  assert.equal(loads.length, 0);
  assert.equal(preview.card.hidden, false);
  assert.match(preview.card.textContent, /No article in this snapshot/);
  assert.match(preview.card.textContent, /source → keyword: 4 text mentions/);
  assert.doesNotMatch(
    preview.card.textContent,
    /keyword → source|Read article/,
  );
});
