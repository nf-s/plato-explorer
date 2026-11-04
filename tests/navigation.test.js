import test from "node:test";
import assert from "node:assert/strict";
import { NavigationHistory, validateNavigation } from "../web/navigation.js";

const nodes = new Map([
  ["agency", { article: true }],
  ["kant", { article: true }],
  ["keyword-dao", { article: false }],
]);

function snapshot() {
  return {
    selected: "agency",
    evidenceTarget: null,
    panel: "graph",
    reader: null,
    mode: "network",
    colourMode: "subject",
    labels: true,
    filters: {
      type: "all",
      minimum: 5,
      common: true,
      kinds: { person: true, topic: true, keyword: false },
    },
    connectionQuery: "",
    connectionLimit: 30,
    listLimit: 80,
    searchQuery: "",
    camera: { scale: 0.8, x: 180, y: 340, width: 390, height: 844 },
    scroll: { inspector: 0, reader: 0, list: 0, filters: 0 },
  };
}

function browser() {
  const entries = [null];
  let cursor = 0;
  const listeners = new Map();
  const storage = new Map();
  const instance = {
    pending: Promise.resolve(),
    historyWrites: 0,
    hidePage: () => listeners.get("pagehide")(),
    history: {
      get state() {
        return structuredClone(entries[cursor]);
      },
      replaceState(value) {
        instance.historyWrites++;
        entries[cursor] = structuredClone(value);
      },
      pushState(value) {
        instance.historyWrites++;
        entries.splice(++cursor);
        entries.push(structuredClone(value));
      },
      back() {
        if (cursor > 0) {
          cursor--;
          instance.pending = listeners.get("popstate")();
        }
      },
      forward() {
        if (cursor + 1 < entries.length) {
          cursor++;
          instance.pending = listeners.get("popstate")();
        }
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  return instance;
}

function setup(host = browser()) {
  let current = snapshot();
  const navigation = new NavigationHistory(host, {
    capture: () => structuredClone(current),
    restore: async (value) => {
      current = structuredClone(value);
    },
    validate: (value) => validateNavigation(value, nodes),
    fromURL: snapshot,
    url: (value) => `/#/${value.selected ?? ""}`,
    changed: () => {},
  });
  return { host, navigation, current: () => current };
}

test("Back and Forward retain reader evidence, filters, camera and scroll positions", async () => {
  const app = setup();
  await app.navigation.start();
  app.current().camera.scale = 2;
  app.navigation.save();
  const graph = structuredClone(app.current());
  app.current().panel = "details";
  app.navigation.push();
  app.current().evidenceTarget = "kant";
  app.navigation.save();
  const evidence = structuredClone(app.current());
  app.current().reader = {
    id: "agency",
    blockIndex: 3,
    highlight: { start: 10, end: 40, target: "kant" },
  };
  app.current().scroll.reader = 1900;
  app.navigation.push();
  const reading = structuredClone(app.current());
  app.navigation.back();
  await app.host.pending;
  assert.deepEqual(app.current(), evidence);
  app.navigation.back();
  await app.host.pending;
  assert.deepEqual(app.current(), graph);
  assert.equal(app.navigation.canBack, false);
  app.navigation.forward();
  await app.host.pending;
  app.navigation.forward();
  await app.host.pending;
  assert.deepEqual(app.current(), reading);
  assert.equal(app.navigation.canForward, false);
});

test("new navigation after Back replaces the forward branch and transient changes do not add entries", async () => {
  const app = setup();
  await app.navigation.start();
  app.current().panel = "filters";
  app.navigation.push();
  app.current().filters.minimum = 12;
  app.navigation.save();
  assert.equal(app.navigation.position, 1);
  app.navigation.back();
  await app.host.pending;
  assert.equal(app.current().filters.minimum, 5);
  app.current().selected = "kant";
  app.navigation.push();
  assert.equal(app.navigation.canForward, false);
  app.navigation.back();
  await app.host.pending;
  app.navigation.forward();
  await app.host.pending;
  assert.equal(app.current().selected, "kant");
  assert.equal(app.current().panel, "graph");
});

test("reload restores current state and retains the forward navigation limit", async () => {
  const app = setup();
  await app.navigation.start();
  app.current().panel = "details";
  app.navigation.push();
  app.current().reader = {
    id: "agency",
    blockIndex: "bibliography",
    highlight: null,
  };
  app.current().scroll.reader = 1000;
  app.navigation.push();
  app.navigation.back();
  await app.host.pending;
  const reloaded = setup(app.host);
  await reloaded.navigation.start();
  assert.equal(reloaded.current().panel, "details");
  assert.equal(reloaded.navigation.canForward, true);
  reloaded.navigation.forward();
  await app.host.pending;
  assert.equal(reloaded.current().reader.blockIndex, "bibliography");
  assert.equal(reloaded.current().scroll.reader, 1000);
});

test("stored navigation rejects unknown nodes, synthetic readers and invalid numeric bounds", () => {
  assert.deepEqual(validateNavigation(snapshot(), nodes), snapshot());
  for (const alter of [
    (value) => {
      value.selected = "missing";
    },
    (value) => {
      value.reader = { id: "keyword-dao", blockIndex: null, highlight: null };
    },
    (value) => {
      value.filters.minimum = 500;
    },
    (value) => {
      value.camera.scale = NaN;
    },
    (value) => {
      value.scroll.reader = -1;
    },
    (value) => {
      value.reader = {
        id: "agency",
        blockIndex: 2,
        highlight: { start: 30, end: 12, target: "kant" },
      };
    },
  ]) {
    const value = snapshot();
    alter(value);
    assert.equal(validateNavigation(value, nodes), null);
  }
});

test("invalid stored history falls back to the URL view", async () => {
  const host = browser();
  host.history.replaceState({
    app: "plato",
    version: 1,
    position: 7,
    session: "invalid",
    snapshot: { selected: "missing" },
  });
  const app = setup(host);
  await app.navigation.start();
  assert.deepEqual(app.current(), snapshot());
  assert.equal(app.navigation.position, 0);
});

test("continuous scrolling avoids history writes and native Back/Forward restores the latest position", async () => {
  const app = setup();
  await app.navigation.start();
  app.current().panel = "details";
  app.navigation.push();
  const writes = app.host.historyWrites;
  for (let position = 1; position <= 500; position++) {
    app.current().scroll.inspector = position;
    app.current().camera.y = position;
    app.navigation.save();
  }
  assert.equal(app.host.historyWrites, writes);
  app.host.history.back();
  await app.host.pending;
  assert.equal(app.current().panel, "graph");
  app.host.history.forward();
  await app.host.pending;
  assert.equal(app.current().panel, "details");
  assert.equal(app.current().scroll.inspector, 500);
  assert.equal(app.current().camera.y, 500);
});

test("pagehide persists pending reading and camera positions before reload", async () => {
  const app = setup();
  await app.navigation.start();
  app.current().reader = { id: "agency", blockIndex: 3, highlight: null };
  app.navigation.push();
  app.current().scroll.reader = 2400;
  app.current().camera.scale = 2.5;
  app.navigation.save();
  app.host.hidePage();
  const reloaded = setup(app.host);
  await reloaded.navigation.start();
  assert.equal(reloaded.current().scroll.reader, 2400);
  assert.equal(reloaded.current().camera.scale, 2.5);
});

test("scroll restoration still works when session storage is unavailable", async () => {
  const app = setup();
  app.host.sessionStorage.setItem = () => {
    throw new DOMException("Storage full", "QuotaExceededError");
  };
  await app.navigation.start();
  app.current().panel = "details";
  app.navigation.push();
  app.current().scroll.inspector = 700;
  app.navigation.save();
  app.host.history.back();
  await app.host.pending;
  app.host.history.forward();
  await app.host.pending;
  assert.equal(app.current().scroll.inspector, 700);
});
