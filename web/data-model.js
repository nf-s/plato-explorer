import { subjects } from "./categories.js";
export const number = new Intl.NumberFormat("en").format;

export function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim();
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "plato.stanford.edu";
  } catch {
    return false;
  }
}

export function validateGraph(data) {
  if (
    !record(data) ||
    data.version !== 1 ||
    !Array.isArray(data.nodes) ||
    !Array.isArray(data.edges) ||
    !Array.isArray(data.communities) ||
    !record(data.meta)
  ) {
    throw new Error(
      "The graph data has an unsupported format. Rebuild it with scripts/build_data.py.",
    );
  }
  if (
    ![
      "articles",
      "nodes",
      "connections",
      "mentions",
      "relatedLinks",
      "unresolvedRelated",
    ].every((field) => integer(data.meta[field])) ||
    data.meta.nodes !== data.nodes.length ||
    data.meta.connections !== data.edges.length
  )
    throw new Error("Invalid graph statistics.");
  const ids = new Set();
  for (const node of data.nodes) {
    if (
      !record(node) ||
      typeof node.id !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(node.id) ||
      ids.has(node.id) ||
      typeof node.title !== "string" ||
      typeof node.summary !== "string" ||
      typeof node.person !== "boolean" ||
      !["person", "topic", "keyword"].includes(node.kind) ||
      node.person !== (node.kind === "person") ||
      typeof node.article !== "boolean" ||
      (node.article && node.kind === "keyword") ||
      (!node.article && node.kind === "topic") ||
      !subjects.has(node.subject) ||
      (node.article ? !validUrl(node.url) : node.url !== null) ||
      !integer(node.mentions) ||
      !integer(node.references) ||
      !integer(node.degree) ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      !integer(node.community) ||
      !Array.isArray(node.aliases) ||
      !node.aliases.every((alias) => typeof alias === "string")
    ) {
      throw new Error("The graph contains an invalid article.");
    }
    ids.add(node.id);
  }
  if (
    data.nodes.filter((node) => node.article).length !== data.meta.articles ||
    data.nodes.some(
      (node, index) => node.article !== index < data.meta.articles,
    )
  )
    throw new Error("Invalid article order or count.");
  const communityIds = new Set();
  for (const community of data.communities) {
    if (
      !record(community) ||
      !integer(community.id) ||
      communityIds.has(community.id) ||
      typeof community.label !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(community.color) ||
      !integer(community.count)
    )
      throw new Error("Invalid community data.");
    communityIds.add(community.id);
  }
  if (data.nodes.some((node) => !communityIds.has(node.community)))
    throw new Error("Missing article community.");
  const pairs = new Set();
  for (const edge of data.edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 6 ||
      !edge.every(integer) ||
      edge[0] >= edge[1] ||
      edge[1] >= data.nodes.length ||
      edge[4] > 1 ||
      edge[5] > 1 ||
      !data.nodes[edge[0]].article ||
      (!data.nodes[edge[1]].article &&
        (edge[3] > 0 || edge[4] > 0 || edge[5] > 0)) ||
      edge.slice(2).every((value) => value === 0)
    )
      throw new Error("The graph contains an invalid connection.");
    const key = `${edge[0]}:${edge[1]}`;
    if (pairs.has(key))
      throw new Error("The graph contains duplicate connections.");
    pairs.add(key);
  }
  return data;
}

export function validateArticle(data, expectedId, ids) {
  if (
    !record(data) ||
    data.id !== expectedId ||
    typeof data.title !== "string" ||
    !validUrl(data.url) ||
    !Array.isArray(data.blocks) ||
    !Array.isArray(data.bibliography) ||
    !Array.isArray(data.related)
  )
    throw new Error("This article has an unsupported format.");
  for (const block of [...data.blocks, ...data.bibliography]) {
    if (
      !record(block) ||
      !["p", "h2", "h3", "h4", "li", "quote"].includes(block.kind) ||
      typeof block.text !== "string" ||
      !Array.isArray(block.links)
    )
      throw new Error("Invalid article text.");
    let previousEnd = 0;
    for (const link of block.links) {
      if (
        !Array.isArray(link) ||
        link.length !== 3 ||
        !integer(link[0]) ||
        !integer(link[1]) ||
        link[0] < previousEnd ||
        link[1] <= link[0] ||
        link[1] > block.text.length ||
        !ids.has(link[2])
      )
        throw new Error("Invalid article link.");
      previousEnd = link[1];
    }
  }
  for (const related of data.related) {
    if (
      !record(related) ||
      typeof related.title !== "string" ||
      (related.id !== null && !ids.has(related.id)) ||
      (related.url !== null && !validUrl(related.url))
    )
      throw new Error("Invalid related entry.");
  }
  return data;
}

export function createIndex(graph) {
  const byId = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const adjacency = graph.nodes.map(() => []);
  graph.edges.forEach((edge, index) => {
    adjacency[edge[0]].push(index);
    adjacency[edge[1]].push(index);
  });
  const terms = graph.nodes.map((node) =>
    [node.title, ...node.aliases].map(normalize),
  );
  return { byId, adjacency, terms };
}

export function commonTermIndices(graph) {
  return new Set(
    graph.nodes.flatMap((node, i) =>
      node.references > graph.meta.articles / 2 ? [i] : [],
    ),
  );
}

export function withoutCommonMentions(graph) {
  const common = commonTermIndices(graph);
  const nodes = graph.nodes.map((node) => ({
    ...node,
    mentions: 0,
    references: 0,
    degree: 0,
  }));
  const edges = [];
  let total = 0;
  for (const [
    source,
    target,
    forward,
    backward,
    relatedForward,
    relatedBackward,
  ] of graph.edges) {
    const outgoing = common.has(target) ? 0 : forward;
    const incoming = common.has(source) ? 0 : backward;
    if (!outgoing && !incoming && !relatedForward && !relatedBackward) continue;
    edges.push([
      source,
      target,
      outgoing,
      incoming,
      relatedForward,
      relatedBackward,
    ]);
    nodes[source].mentions += incoming;
    nodes[target].mentions += outgoing;
    nodes[source].references += Number(incoming > 0);
    nodes[target].references += Number(outgoing > 0);
    nodes[source].degree += 1;
    nodes[target].degree += 1;
    total += outgoing + incoming;
  }
  return {
    ...graph,
    nodes,
    edges,
    meta: { ...graph.meta, connections: edges.length, mentions: total },
  };
}

export function edgeMatches(edge, filters) {
  const mentions = edge[2] + edge[3];
  const related = edge[4] + edge[5] > 0;
  if (filters.type === "related") return related;
  if (filters.type === "mentions") return mentions >= filters.minimum;
  return mentions >= filters.minimum || (filters.minimum === 1 && related);
}

export function nodeMatches(node, filters) {
  return filters.kinds?.[node.kind] !== false;
}

function connectionCounts(edge, selected) {
  const isSource = edge[0] === selected;
  return {
    outgoing: isSource ? edge[2] : edge[3],
    incoming: isSource ? edge[3] : edge[2],
    relatedOut: Boolean(isSource ? edge[4] : edge[5]),
    relatedIn: Boolean(isSource ? edge[5] : edge[4]),
    weight: edge[2] + edge[3],
  };
}

export function connectionBetween(graph, index, sourceId, targetId) {
  const source = index.byId.get(sourceId);
  const target = index.byId.get(targetId);
  if (source === undefined || target === undefined || source === target)
    return null;
  const edgeIndex = index.adjacency[source].find((candidate) => {
    const edge = graph.edges[candidate];
    return edge[0] === target || edge[1] === target;
  });
  return edgeIndex === undefined
    ? null
    : connectionCounts(graph.edges[edgeIndex], source);
}

export function connections(graph, index, selected, filters) {
  return index.adjacency[selected]
    .map((edgeIndex) => {
      const edge = graph.edges[edgeIndex];
      const isSource = edge[0] === selected;
      return {
        index: isSource ? edge[1] : edge[0],
        edgeIndex,
        ...connectionCounts(edge, selected),
      };
    })
    .filter(
      (connection) =>
        edgeMatches(graph.edges[connection.edgeIndex], filters) &&
        nodeMatches(graph.nodes[connection.index], filters) &&
        (filters.community === null ||
          graph.nodes[connection.index].community === filters.community),
    )
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        graph.nodes[a.index].title.localeCompare(graph.nodes[b.index].title),
    );
}

export function visibleGraph(graph, index, selected, filters) {
  let nodes;
  if (selected !== null) {
    const neighbors = connections(graph, index, selected, filters);
    nodes = [selected, ...neighbors.map((connection) => connection.index)];
  } else {
    nodes = graph.nodes.flatMap((node, i) =>
      (filters.community === null || node.community === filters.community) &&
      nodeMatches(node, filters)
        ? [i]
        : [],
    );
  }
  const included = new Set(nodes);
  const edges = graph.edges.filter(
    (edge) =>
      included.has(edge[0]) &&
      included.has(edge[1]) &&
      edgeMatches(edge, filters),
  );
  return { nodes, edges };
}

export function searchArticles(
  graph,
  index,
  query,
  limit = 12,
  people = false,
) {
  const term = normalize(query);
  if (!term) return [];
  const words = term.split(/\s+/);
  const matches = [];
  index.terms.forEach((terms, i) => {
    if (people && !graph.nodes[i].person) return;
    let score = 0;
    if (terms.some((value) => value === term)) score = 4;
    else if (terms.some((value) => value.startsWith(term))) score = 3;
    else if (terms.some((value) => value.includes(term))) score = 2;
    else if (words.every((word) => terms[0].includes(word))) score = 1;
    if (score) matches.push({ index: i, score });
  });
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      graph.nodes[b.index].mentions - graph.nodes[a.index].mentions ||
      graph.nodes[a.index].title.localeCompare(graph.nodes[b.index].title),
  );
  return matches.slice(0, limit).map((match) => match.index);
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
