const VERSION = 1;

function record(value, validate) {
  if (
    !value ||
    value.version !== VERSION ||
    value.app !== "plato" ||
    typeof value.session !== "string" ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0
  )
    return null;
  const snapshot = validate(value.snapshot);
  return snapshot ? { ...value, snapshot } : null;
}

// Browser entries identify each view. Scroll and camera updates stay in a
// session cache, avoiding WebKit's rate limit on history API calls.
export class NavigationHistory {
  constructor(browser, { capture, restore, validate, fromURL, url, changed }) {
    this.browser = browser;
    this.capture = capture;
    this.restore = restore;
    this.validate = validate;
    this.fromURL = fromURL;
    this.url = url;
    this.changed = changed;
    this.restoring = false;
    this.revision = 0;
    this.snapshots = new Map();
    this.pendingSnapshots = new Map();
    this.flushTimer = null;
    browser.history.scrollRestoration = "manual";
    const saved = record(browser.history.state, validate);
    this.session = saved?.session ?? crypto.randomUUID();
    this.position = saved?.position ?? 0;
    this.maximum = this.position;
    try {
      const maximum = Number(browser.sessionStorage.getItem(this.storageKey()));
      if (Number.isSafeInteger(maximum))
        this.maximum = Math.max(this.position, maximum);
    } catch {}
    this.initial = saved ? this.latest(saved) : fromURL();
    browser.addEventListener("popstate", () => this.pop());
    browser.addEventListener("pagehide", () => this.flush());
  }

  storageKey() {
    return `plato-history-${this.session}`;
  }

  snapshotKey(session = this.session, position = this.position) {
    return `plato-view-${session}-${position}`;
  }

  latest(entry) {
    const key = this.snapshotKey(entry.session, entry.position);
    const cached = this.snapshots.get(key);
    if (cached) return structuredClone(cached);
    try {
      const stored = JSON.parse(this.browser.sessionStorage.getItem(key));
      const snapshot = this.validate(stored);
      if (snapshot) return snapshot;
    } catch {}
    return entry.snapshot;
  }

  remember(snapshot) {
    const key = this.snapshotKey();
    this.snapshots.set(key, snapshot);
    this.pendingSnapshots.set(key, snapshot);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [key, snapshot] of this.pendingSnapshots) {
      try {
        this.browser.sessionStorage.setItem(key, JSON.stringify(snapshot));
      } catch {}
    }
    this.pendingSnapshots.clear();
  }

  write(snapshot, push = false) {
    const entry = {
      app: "plato",
      version: VERSION,
      session: this.session,
      position: this.position,
      snapshot,
    };
    this.browser.history[push ? "pushState" : "replaceState"](
      entry,
      "",
      this.url(snapshot),
    );
    this.remember(snapshot);
    this.flush();
    try {
      this.browser.sessionStorage.setItem(
        this.storageKey(),
        String(this.maximum),
      );
    } catch {}
    this.changed();
  }

  async start() {
    this.write(this.initial);
    await this.apply(this.initial);
  }

  save() {
    if (this.restoring) return;
    this.remember(this.capture());
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 250);
  }

  // Rewrites the current entry when a view changes without a new entry.
  replace() {
    if (!this.restoring) this.write(this.capture());
  }

  push() {
    this.position += 1;
    this.maximum = this.position;
    this.write(this.capture(), true);
  }

  get canBack() {
    return this.position > 0;
  }
  get canForward() {
    return this.position < this.maximum;
  }
  back() {
    if (this.canBack) {
      this.save();
      this.flush();
      this.browser.history.back();
    }
  }
  forward() {
    if (this.canForward) {
      this.save();
      this.flush();
      this.browser.history.forward();
    }
  }

  async apply(snapshot) {
    const revision = ++this.revision;
    this.restoring = true;
    try {
      await this.restore(snapshot);
    } finally {
      if (revision === this.revision) {
        this.restoring = false;
        this.changed();
      }
    }
  }

  async pop() {
    this.flush();
    const saved = record(this.browser.history.state, this.validate);
    if (saved) {
      this.session = saved.session;
      this.position = saved.position;
      try {
        const maximum = Number(
          this.browser.sessionStorage.getItem(this.storageKey()),
        );
        this.maximum = Number.isSafeInteger(maximum)
          ? Math.max(this.position, maximum)
          : this.position;
      } catch {
        this.maximum = this.position;
      }
      await this.apply(this.latest(saved));
    } else {
      this.session = crypto.randomUUID();
      this.position = this.maximum = 0;
      const snapshot = this.fromURL();
      this.write(snapshot);
      await this.apply(snapshot);
    }
  }
}

const SECTIONS = ["bibliography", "related"];

// #/article selects a node. #/article/read/block/start-end/target opens the
// reader at a block, a passage in it, and a mention inside that passage.
export function viewHash(saved) {
  if (saved.reader === null)
    return saved.selected === null
      ? ""
      : `#/${encodeURIComponent(saved.selected)}`;
  const { id, blockIndex, highlight } = saved.reader;
  const parts = [encodeURIComponent(id), "read"];
  if (blockIndex !== null) {
    parts.push(String(blockIndex));
    if (highlight !== null) {
      parts.push(`${highlight.start}-${highlight.end}`);
      if (highlight.target !== null)
        parts.push(encodeURIComponent(highlight.target));
    }
  }
  return `#/${parts.join("/")}`;
}

function decoded(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

// An unreadable part is dropped along with everything after it.
export function viewFromHash(hash, nodes) {
  if (!hash.startsWith("#/")) return null;
  const [first, action, block, range, mention, ...rest] = hash
    .slice(2)
    .split("/");
  const id = decoded(first);
  if (id === null || !nodes.has(id)) return null;
  const view = { selected: id, reader: null };
  if (action !== "read" || !nodes.get(id).article) return view;
  view.reader = { id, blockIndex: null, highlight: null };
  if (block === undefined) return view;
  if (SECTIONS.includes(block)) {
    view.reader.blockIndex = block;
    return view;
  }
  if (!/^\d{1,7}$/.test(block)) return view;
  view.reader.blockIndex = Number(block);
  const offsets = range?.match(/^(\d{1,8})-(\d{1,8})$/);
  if (!offsets) return view;
  const start = Number(offsets[1]);
  const end = Number(offsets[2]);
  if (start >= end || end > 10000000) return view;
  view.reader.highlight = { start, end, target: null };
  if (mention === undefined || rest.length) return view;
  const target = decoded(mention);
  if (target !== null && nodes.has(target))
    view.reader.highlight.target = target;
  return view;
}

export function validateNavigation(value, nodes) {
  if (!value || typeof value !== "object") return null;
  const known = (id) => typeof id === "string" && nodes.has(id);
  const integer = (number, min, max) =>
    Number.isInteger(number) && number >= min && number <= max;
  const finite = (number) =>
    typeof number === "number" &&
    Number.isFinite(number) &&
    Math.abs(number) < 1e8;
  if (value.selected !== null && !known(value.selected)) return null;
  if (
    value.evidenceTarget !== null &&
    (!known(value.evidenceTarget) ||
      value.selected === null ||
      value.selected === value.evidenceTarget)
  )
    return null;
  if (!["graph", "details", "filters", "legend"].includes(value.panel))
    return null;
  if (
    !["network", "list"].includes(value.mode) ||
    !["subject", "type", "connections", "neutral"].includes(value.colourMode) ||
    typeof value.labels !== "boolean"
  )
    return null;
  const filter = value.filters;
  if (
    !filter ||
    !["all", "mentions", "related"].includes(filter.type) ||
    !integer(filter.minimum, 1, 50) ||
    typeof filter.common !== "boolean" ||
    !filter.kinds ||
    ["person", "topic", "keyword"].some(
      (kind) => typeof filter.kinds[kind] !== "boolean",
    )
  )
    return null;
  if (
    !integer(value.connectionLimit, 1, 100000) ||
    !integer(value.listLimit, 1, 100000) ||
    typeof value.connectionQuery !== "string" ||
    value.connectionQuery.length > 1000 ||
    typeof value.searchQuery !== "string" ||
    value.searchQuery.length > 1000
  )
    return null;
  // A view opened from a link has no saved reader position yet.
  if (
    !value.scroll ||
    ["inspector", "reader", "list", "filters"].some(
      (key) =>
        !(key === "reader" && value.scroll[key] === null) &&
        (!finite(value.scroll[key]) || value.scroll[key] < 0),
    )
  )
    return null;
  if (
    value.camera !== null &&
    (!value.camera ||
      !finite(value.camera.scale) ||
      value.camera.scale <= 0 ||
      value.camera.scale > 12 ||
      ["x", "y", "width", "height"].some((key) => !finite(value.camera[key])))
  )
    return null;
  if (value.reader !== null) {
    const reading = value.reader;
    if (!reading || !known(reading.id) || !nodes.get(reading.id).article)
      return null;
    if (
      reading.blockIndex !== null &&
      !["bibliography", "related"].includes(reading.blockIndex) &&
      !integer(reading.blockIndex, 0, 1000000)
    )
      return null;
    const mark = reading.highlight;
    if (
      mark !== null &&
      (!mark ||
        !integer(mark.start, 0, 10000000) ||
        !integer(mark.end, mark.start + 1, 10000000) ||
        (mark.target !== null && !known(mark.target)))
    )
      return null;
  }
  return structuredClone(value);
}
