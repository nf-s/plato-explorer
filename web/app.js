import {
  commonTermIndices,
  connections,
  createIndex,
  element,
  normalize,
  number,
  searchArticles,
  validateGraph,
  visibleGraph,
  withoutCommonMentions,
} from "./data-model.js";
import { GraphView } from "./graph-view.js";
import { ArticleReader } from "./reader.js";
import { ConnectionEvidence } from "./evidence.js";
import { category, nodeColor, palette } from "./categories.js";
import { FullTextSearch } from "./full-text-search.js";
import { NavigationHistory, validateNavigation } from "./navigation.js";

function get(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node;
}

const search = get("search");
const results = get("search-results");
const inspector = get("inspector-content");
const inspectorScroll = get("inspector-scroll");
const filters = {
  type: "all",
  minimum: 5,
  community: null,
  common: true,
  kinds: { person: true, topic: true, keyword: false },
};
const state = {
  selected: null,
  evidenceTarget: null,
  colourMode: "subject",
  labels: true,
  mode: "network",
  listLimit: 80,
  connectionLimit: 30,
  connectionQuery: "",
  resultActions: [],
  activeResult: -1,
  panel: "graph",
  reading: null,
};
let graph;
let index;
let sourceGraph;
let reducedGraph;
let sourceIndex;
let reducedIndex;
let view;
let reader;
let evidence;
let evidenceTask;
let fullText;
let searchController;
let searchTimer;
let navigation;
let restoreRevision = 0;
const mobile = window.matchMedia(
  "(max-width: 760px), (max-width: 1000px) and (max-height: 600px) and (pointer: coarse)",
);
let visible = { nodes: [], edges: [] };

function captureView() {
  return {
    selected: state.selected === null ? null : graph.nodes[state.selected].id,
    evidenceTarget:
      state.evidenceTarget === null
        ? null
        : graph.nodes[state.evidenceTarget].id,
    panel: state.panel,
    reader: state.reading ? structuredClone(state.reading) : null,
    mode: state.mode,
    colourMode: state.colourMode,
    labels: state.labels,
    filters: {
      type: filters.type,
      minimum: filters.minimum,
      common: filters.common,
      kinds: { ...filters.kinds },
    },
    connectionQuery: state.connectionQuery,
    connectionLimit: state.connectionLimit,
    listLimit: state.listLimit,
    searchQuery: search.value,
    camera: view.positions.size ? view.camera() : null,
    scroll: {
      inspector: inspectorScroll.scrollTop,
      reader: document.querySelector(".reader-article").scrollTop,
      list: get("article-list").scrollTop,
      filters: get("filters").scrollTop,
    },
  };
}

function syncControls() {
  get("link-type").value = filters.type;
  get("min-mentions").value = String(filters.minimum);
  get("hide-common").checked = filters.common;
  get("colour-mode").value = state.colourMode;
  get("show-labels").checked = state.labels;
  for (const kind of Object.keys(filters.kinds))
    get(`show-${kind}`).checked = filters.kinds[kind];
}

function syncPanels() {
  const details = mobile.matches && state.panel === "details";
  const filtering = state.panel === "filters";
  document.body.classList.toggle("mobile-details-open", details);
  get("inspector").hidden = mobile.matches && !details;
  get("inspector").inert = mobile.matches && !details;
  if (details) {
    get("inspector").setAttribute("role", "dialog");
    get("inspector").setAttribute("aria-modal", "true");
  } else {
    get("inspector").removeAttribute("role");
    get("inspector").removeAttribute("aria-modal");
  }
  get("filters").hidden = !filtering;
  if (mobile.matches && filtering) {
    get("filters").setAttribute("role", "dialog");
    get("filters").setAttribute("aria-modal", "true");
    get("filters").setAttribute("aria-label", "Filters");
  } else {
    get("filters").removeAttribute("role");
    get("filters").removeAttribute("aria-modal");
  }
  get("filters-button").setAttribute("aria-expanded", String(filtering));
  get("details-open").setAttribute("aria-expanded", String(details));
  get("legend-panel").hidden = mobile.matches && state.panel !== "legend";
  get("legend-toggle").setAttribute(
    "aria-expanded",
    String(state.panel === "legend"),
  );
  if (mobile.matches) document.querySelector(".colour-legend").open = true;
  document.querySelector(".graph-panel").inert = details;
  for (const selector of [
    ".graph-toolbar",
    "#graph",
    "#article-list",
    ".graph-bottom",
    ".graph-heading",
    "#legend-panel",
  ]) {
    document.querySelector(selector).inert = mobile.matches && filtering;
  }
  if (mobile.matches && filtering) get("inspector").inert = true;
}

function historyButtons() {
  get("history-back").disabled = !navigation?.canBack;
  get("history-forward").disabled = !navigation?.canForward;
}

function changeView(change, fit = false) {
  navigation?.save();
  change();
  update(fit);
  syncControls();
  syncPanels();
  navigation?.push();
}

function openPanel(panel) {
  if (state.panel === panel) return;
  changeView(() => {
    state.panel = panel;
  });
  const focus = {
    details: "details-close",
    filters: "filters-close",
    legend: "legend-close",
    graph: "details-open",
  }[panel];
  if (mobile.matches) get(focus).focus({ preventScroll: true });
}

async function restoreView(saved) {
  const revision = ++restoreRevision;
  hideSearch();
  evidence.cancel();
  reader.dismiss();
  Object.assign(filters, saved.filters, {
    kinds: { ...saved.filters.kinds },
    community: null,
  });
  state.selected =
    saved.selected === null ? null : sourceIndex.byId.get(saved.selected);
  state.evidenceTarget =
    saved.evidenceTarget === null
      ? null
      : sourceIndex.byId.get(saved.evidenceTarget);
  state.panel = saved.panel;
  state.reading = saved.reader;
  state.colourMode = saved.colourMode;
  state.labels = saved.labels;
  state.connectionQuery = saved.connectionQuery;
  state.connectionLimit = saved.connectionLimit;
  state.listLimit = saved.listLimit;
  search.value = saved.searchQuery;
  state.mode = saved.mode;
  syncControls();
  update(saved.camera === null);
  setMode(saved.mode);
  syncPanels();
  if (saved.camera) view.restoreCamera(saved.camera);
  if (state.evidenceTarget !== null) await evidenceTask;
  if (revision !== restoreRevision) return;
  inspectorScroll.scrollTop = saved.scroll.inspector;
  get("article-list").scrollTop = saved.scroll.list;
  get("filters").scrollTop = saved.scroll.filters;
  if (saved.reader) {
    const node = graph.nodes[sourceIndex.byId.get(saved.reader.id)];
    await reader.show(node, saved.reader.blockIndex, saved.reader.highlight);
    if (revision !== restoreRevision) return;
    document.querySelector(".reader-article").scrollTop = saved.scroll.reader;
  }
}

function openReader(node, blockIndex = null, highlight = null) {
  navigation.save();
  hideSearch();
  state.reading = { id: node.id, blockIndex, highlight };
  reader.show(node, blockIndex, highlight);
  navigation.push();
}

function closeReader() {
  if (navigation.canBack) navigation.back();
  else {
    state.reading = null;
    reader.dismiss();
    navigation.save();
  }
}

function dot(node) {
  const marker = element("span", "colour-dot");
  if (node) marker.style.background = nodeColor(node, state.colourMode);
  return marker;
}

function navigate(nodeIndex) {
  if (!graph) return;
  if (
    nodeIndex === state.selected &&
    !state.reading &&
    mobile.matches &&
    state.panel === "graph"
  ) {
    openPanel("details");
    return;
  }
  changeView(() => {
    hideSearch();
    search.value = "";
    search.blur();
    reader.dismiss();
    state.reading = null;
    state.panel = "graph";
    filters.community = null;
    select(nodeIndex);
    setMode("network");
  }, true);
}

function select(nodeIndex) {
  evidence?.cancel();
  state.evidenceTarget = null;
  state.selected = nodeIndex;
  state.connectionLimit = 30;
  state.connectionQuery = "";
  state.listLimit = 80;
  inspectorScroll.scrollTop = 0;
  get("announcement").textContent =
    nodeIndex === null
      ? "Showing nodes matching these filters."
      : `Selected ${graph.nodes[nodeIndex].title}. ${number(visible.nodes.length - 1)} connected nodes shown.`;
}

function entryRow(nodeIndex, count, subtitle) {
  const node = graph.nodes[nodeIndex];
  const row = element("button", "entry-row");
  row.append(dot(node), element("span", "entry-name", node.title));
  const info = element("span", "entry-info", count);
  if (subtitle) info.append(element("small", "", subtitle));
  row.append(info, element("span", "entry-arrow", "↗"));
  row.addEventListener("click", () => navigate(nodeIndex));
  return row;
}

function stats(values) {
  const row = element("div", "stats");
  for (const [value, label] of values) {
    const stat = element("div", "stat");
    stat.append(
      element("strong", "", number(value)),
      element("span", "", label),
    );
    row.append(stat);
  }
  return row;
}

function sectionTitle(text, note) {
  const title = element("h3", "section-title", text);
  if (note) title.append(element("small", "", note));
  return title;
}

function renderOverview() {
  const fragment = document.createDocumentFragment();
  fragment.append(
    stats([
      [visible.nodes.length, "Nodes"],
      [visible.edges.length, "Connections"],
    ]),
  );
  fragment.append(sectionTitle("Most mentioned"));
  const top = [...visible.nodes]
    .sort((a, b) => graph.nodes[b].mentions - graph.nodes[a].mentions)
    .slice(0, 12);
  for (const nodeIndex of top)
    fragment.append(
      entryRow(nodeIndex, number(graph.nodes[nodeIndex].mentions)),
    );
  inspector.replaceChildren(fragment);
}

function renderSelection() {
  const node = graph.nodes[state.selected];
  const fragment = document.createDocumentFragment();
  const top = element("div", "selection-top");
  const close = element("button", "", "×");
  close.setAttribute("aria-label", "Clear selected node");
  close.addEventListener("click", () => navigate(null));
  top.append(element("h2", "", node.title), close);
  fragment.append(top);
  if (node.article) {
    fragment.append(
      element(
        "p",
        "article-summary",
        node.summary || "No introduction is available in this snapshot.",
      ),
    );
    const read = element("button", "primary-button", "Read article");
    read.addEventListener("click", () => reader.open(node));
    const original = element("a", "secondary-button", "Original on SEP ↗");
    original.href = node.url;
    original.target = "_blank";
    original.rel = "noreferrer";
    const actions = element("div", "action-pair");
    actions.append(original);
    fragment.append(read, actions);
  } else {
    fragment.append(
      element(
        "p",
        "node-type-label",
        node.kind === "keyword"
          ? "Keyword · no article in snapshot"
          : "Person · no article in snapshot",
      ),
    );
  }
  fragment.append(
    stats([
      [node.mentions, "Incoming mentions"],
      [node.degree, node.article ? "Connected nodes" : "Mentioning articles"],
    ]),
  );
  const connected = connections(graph, index, state.selected, filters);
  fragment.append(
    sectionTitle(
      node.article ? "Connected nodes" : "Mentioning articles",
      `${number(connected.length)} shown`,
    ),
  );
  const input = element("input", "connections-search");
  input.type = "search";
  input.maxLength = 1000;
  input.placeholder = node.article
    ? "Filter connected nodes…"
    : "Filter mentioning articles…";
  input.setAttribute(
    "aria-label",
    node.article ? "Filter connected nodes" : "Filter mentioning articles",
  );
  input.value = state.connectionQuery;
  input.addEventListener("input", () => {
    state.connectionQuery = input.value;
    state.connectionLimit = 30;
    renderConnections(connected);
    navigation.save();
  });
  fragment.append(input, element("div", "connection-rows"));
  inspector.replaceChildren(fragment);
  renderConnections(connected);
}

function renderConnections(connected) {
  const container = inspector.querySelector(".connection-rows");
  if (!container) return;
  const term = normalize(state.connectionQuery);
  const matches = connected.filter((connection) =>
    normalize(graph.nodes[connection.index].title).includes(term),
  );
  const fragment = document.createDocumentFragment();
  for (const connection of matches.slice(0, state.connectionLimit)) {
    const subtitle =
      connection.relatedIn || connection.relatedOut
        ? "related entry"
        : "text mentions";
    const selectedNode = graph.nodes[state.selected];
    const otherNode = graph.nodes[connection.index];
    const count = !selectedNode.article
      ? `${number(connection.incoming)} mentions`
      : !otherNode.article
        ? `${number(connection.outgoing)} mentions`
        : `${number(connection.outgoing)} out · ${number(connection.incoming)} in`;
    const row = entryRow(connection.index, count, subtitle);
    row.title = !selectedNode.article
      ? `${otherNode.title} mentions ${selectedNode.title} ${number(connection.incoming)} times.`
      : !otherNode.article
        ? `${selectedNode.title} mentions ${otherNode.title} ${number(connection.outgoing)} times.`
        : `${selectedNode.title} mentions ${otherNode.title} ${number(connection.outgoing)} times; the other article mentions this one ${number(connection.incoming)} times.${connection.relatedOut ? " Listed as a related entry here." : ""}${connection.relatedIn ? " This article is listed as a related entry there." : ""}`;
    const pair = element("div", "connection-row");
    const inspect = element(
      "button",
      "text-button evidence-button",
      "Mentions",
    );
    inspect.setAttribute(
      "aria-label",
      `View mentions between ${graph.nodes[state.selected].title} and ${graph.nodes[connection.index].title}`,
    );
    inspect.addEventListener("click", () => compare(connection.index));
    pair.append(row, inspect);
    fragment.append(pair);
  }
  if (!matches.length)
    fragment.append(
      element(
        "p",
        "connection-note",
        "No connected nodes match these filters.",
      ),
    );
  if (matches.length > state.connectionLimit) {
    const more = element(
      "button",
      "text-button more-connections",
      `Show more (${number(matches.length - state.connectionLimit)} remaining)`,
    );
    more.addEventListener("click", () => {
      state.connectionLimit += 50;
      renderConnections(connected);
      navigation.save();
    });
    fragment.append(more);
  }
  container.replaceChildren(fragment);
}

function renderList() {
  const rows = get("article-list-rows");
  const sorted = [...visible.nodes].sort(
    (a, b) =>
      graph.nodes[b].mentions - graph.nodes[a].mentions ||
      graph.nodes[a].title.localeCompare(graph.nodes[b].title),
  );
  rows.replaceChildren(
    ...sorted
      .slice(0, state.listLimit)
      .map((nodeIndex) =>
        entryRow(nodeIndex, number(graph.nodes[nodeIndex].mentions)),
      ),
  );
  get("more-articles").hidden = sorted.length <= state.listLimit;
}

function compare(target) {
  if (state.selected === null || target === state.selected) return;
  if (
    !connections(graph, index, state.selected, filters).some(
      (item) => item.index === target,
    )
  )
    return;
  changeView(() => {
    state.evidenceTarget = target;
    state.panel = "details";
    inspectorScroll.scrollTop = 0;
  });
}

function showEvidence() {
  evidenceTask = evidence.open(
    inspector,
    graph.nodes[state.selected],
    graph.nodes[state.evidenceTarget],
    () => {
      if (navigation.canBack) navigation.back();
      else
        changeView(() => {
          evidence.cancel();
          state.evidenceTarget = null;
        });
    },
  );
}

function renderLegend() {
  const labels = {
    subject: "Subjects (estimated)",
    type: "Node types",
    connections: "Connection counts",
    neutral: "",
  };
  get("colour-label").textContent = labels[state.colourMode];
  get("colour-label").parentElement.hidden = state.colourMode === "neutral";
  const counts = new Map();
  for (const i of visible.nodes) {
    const label = category(graph.nodes[i], state.colourMode);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  get("colour-legend").replaceChildren(
    ...[...palette(state.colourMode)].flatMap(([label, color]) => {
      if (!counts.has(label)) return [];
      const item = element("span", "legend-item");
      const marker = dot();
      marker.style.background = color;
      item.append(
        marker,
        document.createTextNode(`${label} · ${number(counts.get(label))}`),
      );
      return [item];
    }),
  );
}

function update(fit = true) {
  if (!graph) return;
  graph = filters.common ? reducedGraph : sourceGraph;
  index = filters.common ? reducedIndex : sourceIndex;
  view.graph = graph;
  view.colorMode = state.colourMode;
  visible = visibleGraph(graph, index, state.selected, filters);
  view.setView(visible, state.selected, state.labels, fit);
  get("graph-title").textContent =
    state.selected === null
      ? Object.entries({
          person: "People",
          topic: "Topics",
          keyword: "Keywords",
        })
          .filter(([kind]) => filters.kinds[kind])
          .map(([, label]) => label)
          .join(" · ") || "No node types selected"
      : graph.nodes[state.selected].title;
  get("visible-count").textContent =
    `${number(visible.nodes.length)} nodes · ${number(visible.edges.length)} connections`;
  get("layout-label").textContent = filters.common
    ? "Common-term mentions hidden"
    : "All mentions included";
  get("reset-view").hidden =
    state.selected === null && filters.community === null;
  get("graph-empty").hidden =
    state.mode === "list" ||
    (state.selected === null
      ? visible.nodes.length > 0
      : visible.edges.length > 0);
  get("empty-reset").textContent =
    filters.minimum > 1 && filters.type !== "related"
      ? "Show weaker connections"
      : "Reset filters";
  get("min-mentions").disabled = filters.type === "related";
  get("min-mentions-value").textContent = String(filters.minimum);
  const filterCount =
    Number(filters.type !== "all") +
    Number(filters.minimum > 1 && filters.type !== "related") +
    Number(filters.common) +
    Number(!filters.kinds.person) +
    Number(!filters.kinds.topic) +
    Number(!filters.kinds.keyword);
  get("filter-count").hidden = filterCount === 0;
  get("filter-count").textContent = String(filterCount);
  if (state.selected === null) renderOverview();
  else if (state.evidenceTarget !== null) showEvidence();
  else renderSelection();
  renderLegend();
  if (state.mode === "list") renderList();
}

function setMode(mode) {
  state.mode = mode;
  get("graph").hidden = mode === "list";
  get("article-list").hidden = mode !== "list";
  document.querySelector(".zoom-controls").hidden = mode === "list";
  get("graph-empty").hidden =
    mode === "list" ||
    (state.selected === null
      ? visible.nodes.length > 0
      : visible.edges.length > 0);
  for (const [id, selected] of [
    ["network-mode", mode === "network"],
    ["list-mode", mode === "list"],
  ]) {
    get(id).classList.toggle("active", selected);
    get(id).setAttribute("aria-pressed", String(selected));
  }
  if (mode === "list") renderList();
  else view.resize();
}

function resetFilters() {
  filters.type = "all";
  filters.minimum = 5;
  filters.community = null;
  filters.common = true;
  filters.kinds = { person: true, topic: true, keyword: false };
  for (const kind of Object.keys(filters.kinds))
    get(`show-${kind}`).checked = filters.kinds[kind];
  get("link-type").value = "all";
  get("min-mentions").value = "5";
  get("hide-common").checked = true;
}

function hideSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  results.hidden = true;
  search.setAttribute("aria-expanded", "false");
  search.removeAttribute("aria-activedescendant");
  state.activeResult = -1;
}

function addSearchOption(
  nodeIndex,
  label,
  description,
  activate,
  highlights = [],
) {
  const node = graph.nodes[nodeIndex];
  const resultIndex = state.resultActions.length;
  state.resultActions.push(activate);
  const result = element("button", "search-result");
  result.id = `search-result-${resultIndex}`;
  result.setAttribute("role", "option");
  result.setAttribute("aria-selected", "false");
  result.tabIndex = -1;
  const text = element("span", "search-result-text");
  text.append(element("strong", "", node.title));
  const excerpt = element("small");
  let position = 0;
  for (const [start, end] of highlights) {
    excerpt.append(
      document.createTextNode(description.slice(position, start)),
      element("mark", "", description.slice(start, end)),
    );
    position = end;
  }
  excerpt.append(document.createTextNode(description.slice(position)));
  text.append(excerpt);
  result.append(dot(node), text, element("span", "result-arrow", label));
  result.addEventListener("click", activate);
  results.append(result);
}

function showSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  if (!graph || !search.value.trim()) {
    hideSearch();
    return;
  }
  const query = search.value.trim();
  const controller = new AbortController();
  searchController = controller;
  state.resultActions = [];
  state.activeResult = -1;
  search.removeAttribute("aria-activedescendant");
  results.replaceChildren();
  const titles = searchArticles(graph, index, query, 6);
  if (titles.length)
    results.append(
      element("p", "search-section", "Nodes · explore connections"),
    );
  titles.forEach((nodeIndex) =>
    addSearchOption(
      nodeIndex,
      "↗",
      `${number(graph.nodes[nodeIndex].mentions)} incoming mentions`,
      () => navigate(nodeIndex),
    ),
  );
  const status = element("p", "search-section", "Searching article text…");
  status.setAttribute("role", "status");
  results.append(status);
  results.hidden = false;
  search.setAttribute("aria-expanded", "true");
  let offset = 0;
  const more = element(
    "button",
    "text-button more-search",
    "Show more results",
  );
  more.addEventListener("click", () => loadText());
  async function loadText() {
    more.disabled = true;
    try {
      const found = await fullText.search(query, {
        signal: controller.signal,
        limit: 8,
        offset,
      });
      if (controller.signal.aborted) return;
      status.textContent = found.total
        ? `Article text · ${number(found.total)} results · all words`
        : "No article text matches all these words.";
      more.remove();
      for (const match of found.results) {
        addSearchOption(
          match.index,
          "Read",
          match.snippet,
          () => {
            hideSearch();
            reader.open(
              graph.nodes[match.index],
              match.section === "Bibliography"
                ? "bibliography"
                : match.blockIndex,
            );
          },
          match.highlights,
        );
      }
      offset += found.results.length;
      if (offset < found.total) {
        more.disabled = false;
        results.append(more);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent =
        error instanceof Error
          ? error.message
          : "Text search is unavailable. Try again.";
      more.disabled = false;
    }
  }
  searchTimer = setTimeout(loadText, 250);
}

function bind() {
  search.addEventListener("input", () => {
    showSearch();
    navigation.save();
  });
  search.addEventListener("focus", () => {
    if (search.value) showSearch();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideSearch();
      return;
    }
    if (event.key === "Tab") {
      hideSearch();
      return;
    }
    if (results.hidden || !state.resultActions.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = state.resultActions.length;
      state.activeResult =
        state.activeResult === -1
          ? event.key === "ArrowDown"
            ? 0
            : count - 1
          : (state.activeResult +
              (event.key === "ArrowDown" ? 1 : -1) +
              count) %
            count;
      [...results.querySelectorAll("[role=option]")].forEach((option, i) =>
        option.setAttribute("aria-selected", String(i === state.activeResult)),
      );
      const id = `search-result-${state.activeResult}`;
      search.setAttribute("aria-activedescendant", id);
      get(id).scrollIntoView({ block: "nearest" });
    }
    if (event.key === "Enter") {
      event.preventDefault();
      state.resultActions[Math.max(state.activeResult, 0)]();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      event.target instanceof Node &&
      !document.querySelector(".search-wrap")?.contains(event.target)
    )
      hideSearch();
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !(event.target instanceof HTMLInputElement) &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      search.focus();
    }
    if (event.key === "Escape") {
      if (!reader.dialog.open && state.panel !== "graph") openPanel("graph");
    }
    const modal =
      mobile.matches && !reader.dialog.open
        ? state.panel === "details"
          ? get("inspector")
          : state.panel === "filters"
            ? get("filters")
            : null
        : null;
    if (event.key === "Tab" && modal) {
      const controls = [
        ...modal.querySelectorAll(
          "button, a[href], input, select, summary, [tabindex]",
        ),
      ].filter(
        (node) =>
          !node.disabled && node.tabIndex >= 0 && node.getClientRects().length,
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (
        first &&
        last &&
        (!modal.contains(document.activeElement) ||
          (!event.shiftKey && document.activeElement === last) ||
          (event.shiftKey && document.activeElement === first))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  });
  get("filters-button").addEventListener("click", () => {
    openPanel(state.panel === "filters" ? "graph" : "filters");
  });
  get("filters-close").addEventListener("click", () => openPanel("graph"));
  get("details-open").addEventListener("click", () => openPanel("details"));
  get("details-close").addEventListener("click", () => openPanel("graph"));
  get("legend-toggle").addEventListener("click", () =>
    openPanel(state.panel === "legend" ? "graph" : "legend"),
  );
  get("legend-close").addEventListener("click", () => openPanel("graph"));
  get("history-back").addEventListener("click", () => navigation.back());
  get("history-forward").addEventListener("click", () => navigation.forward());
  get("link-type").addEventListener("change", (event) => {
    changeView(() => {
      filters.type = event.target.value;
    }, true);
  });
  for (const kind of Object.keys(filters.kinds)) {
    get(`show-${kind}`).addEventListener("change", (event) => {
      changeView(() => {
        filters.kinds[kind] = event.target.checked;
      }, true);
    });
  }
  const firefoxNotice = get("firefox-notice");
  if (/Firefox\//.test(navigator.userAgent)) {
    try {
      firefoxNotice.hidden =
        sessionStorage.getItem("plato-firefox-notice-dismissed") === "true";
    } catch {
      firefoxNotice.hidden = false;
    }
  }
  get("firefox-notice-close").addEventListener("click", () => {
    firefoxNotice.hidden = true;
    try {
      sessionStorage.setItem("plato-firefox-notice-dismissed", "true");
    } catch {}
  });
  get("colour-mode").addEventListener("change", (event) => {
    changeView(() => {
      state.colourMode = event.target.value;
    });
  });
  get("hide-common").addEventListener("change", (event) => {
    changeView(() => {
      filters.common = event.target.checked;
    }, true);
  });
  let adjustingMinimum = false;
  get("min-mentions").addEventListener("input", (event) => {
    if (!adjustingMinimum) navigation.save();
    filters.minimum = Number(event.target.value);
    update(false);
    if (adjustingMinimum) navigation.save();
    else navigation.push();
    adjustingMinimum = true;
  });
  get("min-mentions").addEventListener("change", () => {
    adjustingMinimum = false;
  });
  get("show-labels").addEventListener("change", (event) => {
    changeView(() => {
      state.labels = event.target.checked;
    });
  });
  get("reset-filters").addEventListener("click", () =>
    changeView(resetFilters, true),
  );
  get("empty-reset").addEventListener("click", () => {
    changeView(() => {
      if (filters.minimum > 1 && filters.type !== "related") {
        filters.minimum = 1;
        get("min-mentions").value = "1";
      } else resetFilters();
    }, true);
  });
  get("reset-view").addEventListener("click", () => navigate(null));
  get("network-mode").addEventListener("click", () =>
    changeView(() => setMode("network")),
  );
  get("list-mode").addEventListener("click", () =>
    changeView(() => setMode("list")),
  );
  get("more-articles").addEventListener("click", () => {
    state.listLimit += 100;
    renderList();
    navigation.save();
  });
  get("zoom-in").addEventListener("click", () => {
    view.zoom(1.35);
    navigation.save();
  });
  get("zoom-out").addEventListener("click", () => {
    view.zoom(1 / 1.35);
    navigation.save();
  });
  get("fit-view").addEventListener("click", () => {
    view.fit();
    navigation.save();
  });
  get("about-button").addEventListener("click", () => get("about").showModal());
  get("about-close").addEventListener("click", () => get("about").close());
  for (const event of ["pointerup", "pointercancel", "wheel", "keydown"])
    get("graph").addEventListener(event, () => navigation.save());
  for (const target of [
    inspectorScroll,
    get("article-list"),
    get("filters"),
    document.querySelector(".reader-article"),
  ])
    target.addEventListener("scroll", () => navigation.save(), {
      passive: true,
    });
  mobile.addEventListener("change", () => {
    reader.closeContents();
    syncPanels();
    view.resize();
    navigation.save();
  });
}

async function start() {
  try {
    const response = await fetch("./data/graph.json");
    if (!response.ok)
      throw new Error(
        "The graph data is missing. Run the data build command below, then reload.",
      );
    sourceGraph = validateGraph(await response.json());
    reducedGraph = withoutCommonMentions(sourceGraph);
    sourceIndex = createIndex(sourceGraph);
    reducedIndex = createIndex(reducedGraph);
    graph = reducedGraph;
    index = reducedIndex;
    reader = new ArticleReader(graph, (id) => {
      const nodeIndex = index.byId.get(id);
      if (nodeIndex !== undefined) navigate(nodeIndex);
    });
    evidence = new ConnectionEvidence(reader);
    fullText = new FullTextSearch(sourceGraph, reader);
    view = new GraphView(
      get("graph"),
      graph,
      (nodeIndex, shift) => {
        if (shift && state.selected !== null && nodeIndex !== state.selected)
          compare(nodeIndex);
        else navigate(nodeIndex);
      },
      (hover) => {
        const tooltip = get("graph-tooltip");
        tooltip.hidden = hover === null;
        if (!hover) return;
        const title = element("div", "graph-tooltip-title");
        const badge = element(
          "small",
          "node-badge",
          hover.node.article
            ? "Article"
            : hover.node.kind === "keyword"
              ? "Keyword"
              : "Person",
        );
        if (!hover.node.article && hover.node.kind === "person") {
          badge.title = "Person without a dedicated article";
          badge.setAttribute("aria-label", badge.title);
        }
        title.append(element("strong", "", hover.node.title), badge);
        tooltip.replaceChildren(
          title,
          element(
            "small",
            "",
            `${number(hover.node.mentions)} incoming mentions · ${number(hover.node.degree)} connections`,
          ),
        );
        if (
          state.selected !== null &&
          hover.node.id !== graph.nodes[state.selected].id
        )
          tooltip.append(
            element("small", "", "Shift-click to inspect passages"),
          );
        tooltip.style.left = `${Math.max(10, Math.min(hover.x + 16, hover.width - 290))}px`;
        tooltip.style.top = `${Math.min(hover.y + 15, hover.height - 115)}px`;
      },
    );
    const commonNames = [...commonTermIndices(sourceGraph)]
      .map((i) => sourceGraph.nodes[i].title)
      .sort();
    get("common-terms-summary").textContent =
      `${commonNames.length} common terms`;
    get("common-terms-list").textContent = commonNames.join(", ");
    get("about-data").textContent =
      `${number(graph.meta.articles)} articles and ${number(graph.nodes.length - graph.meta.articles)} additional person/keyword nodes from the supplied corpus. The complete dataset contains ${number(sourceGraph.meta.mentions)} detected text mentions and ${number(sourceGraph.meta.relatedLinks)} related-entry links.`;
    const defaultView = captureView();
    const nodes = new Map(sourceGraph.nodes.map((node) => [node.id, node]));
    navigation = new NavigationHistory(window, {
      capture: captureView,
      restore: restoreView,
      validate: (saved) => validateNavigation(saved, nodes),
      fromURL: () => {
        const saved = structuredClone(defaultView);
        const match = location.hash.match(/^#\/([^/]+)$/);
        if (match) {
          try {
            const id = decodeURIComponent(match[1]);
            if (nodes.has(id)) saved.selected = id;
          } catch {}
        }
        return saved;
      },
      url: (saved) =>
        `${location.pathname}${location.search}${saved.selected === null ? "" : `#/${encodeURIComponent(saved.selected)}`}`,
      changed: historyButtons,
    });
    reader.onOpen = openReader;
    reader.onClose = closeReader;
    reader.onLocation = (blockIndex) => {
      if (state.reading)
        openReader(
          graph.nodes[sourceIndex.byId.get(state.reading.id)],
          blockIndex,
        );
    };
    bind();
    await navigation.start();
    get("loading").hidden = true;
  } catch (error) {
    const message = element("div", "error-message");
    message.append(
      element(
        "p",
        "",
        error instanceof Error
          ? error.message
          : "The encyclopedia could not be loaded.",
      ),
      element("code", "", ".venv/bin/python scripts/build_data.py"),
    );
    const reload = element("button", "secondary-button", "Reload");
    reload.addEventListener("click", () => location.reload());
    message.append(reload);
    get("loading").replaceChildren(message);
  }
}

start();
