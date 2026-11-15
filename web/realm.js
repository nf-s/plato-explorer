// A realm is one corpus with its own graph, articles and search index under
// data/<realm>/. The copy that names its source comes from its realm.json.
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function httpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const REALM_ID = /^[a-z][a-z0-9-]*$/;

// The realm menu lists every built realm; the first is the default.
export function validateRealms(data) {
  if (
    !record(data) ||
    !Array.isArray(data.realms) ||
    !data.realms.length ||
    !data.realms.every(
      (entry) =>
        record(entry) &&
        typeof entry.id === "string" &&
        REALM_ID.test(entry.id) &&
        ["name", "source", "sourceShortName"].every((field) =>
          text(entry[field]),
        ),
    ) ||
    new Set(data.realms.map((entry) => entry.id)).size !== data.realms.length
  )
    throw new Error("The realm list has an unsupported format.");
  return data.realms.map(({ id, name, source, sourceShortName }) => ({
    id,
    name,
    source,
    sourceShortName,
  }));
}

// Addresses without a known realm, including those shared before realms
// existed, open the default realm.
export function chosenRealm(realms, search) {
  const requested = new URLSearchParams(search).get("realm");
  return realms.find((realm) => realm.id === requested) ?? realms[0];
}

export function realmHref(realms, id, nodeId = null) {
  const query = id === realms[0].id ? "" : `?realm=${encodeURIComponent(id)}`;
  const hash = nodeId === null ? "" : `#/${encodeURIComponent(nodeId)}`;
  return `./${query}${hash}`;
}

// Two realms can cover one field from different sources. A name that another
// realm shares is followed by its source.
export function realmLabel(realms, realm) {
  return realms.some(
    (other) => other.id !== realm.id && other.name === realm.name,
  )
    ? `${realm.name} (${realm.sourceShortName})`
    : realm.name;
}

export function dataPath(realm) {
  return `./data/${realm.id}/`;
}

export function validateRealm(data, id) {
  if (
    !record(data) ||
    data.id !== id ||
    !["name", "description"].every((field) => text(data[field])) ||
    !record(data.source) ||
    !["name", "shortName", "footer", "articleRights", "readerNotice"].every(
      (field) => text(data.source[field]),
    ) ||
    !httpsUrl(data.source.url) ||
    !httpsUrl(data.source.copyrightUrl) ||
    !Array.isArray(data.source.hosts) ||
    !data.source.hosts.length ||
    !data.source.hosts.every((host) => /^[a-z0-9.-]+$/.test(host)) ||
    !record(data.about) ||
    !Array.isArray(data.about.copyright) ||
    !data.about.copyright.length ||
    !data.about.copyright.every(text) ||
    !["copyrightLink", "commonTermExamples", "subjectNote"].every((field) =>
      text(data.about[field]),
    ) ||
    !record(data.defaults) ||
    !Number.isSafeInteger(data.defaults.minimumMentions) ||
    data.defaults.minimumMentions < 1 ||
    data.defaults.minimumMentions > 50 ||
    !Array.isArray(data.subjects) ||
    !data.subjects.length ||
    !data.subjects.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        text(entry[0]) &&
        /^#[0-9a-f]{6}$/i.test(entry[1]),
    )
  )
    throw new Error(
      "The realm settings have an unsupported format. Rebuild the data.",
    );
  return data;
}

// Each realm lists the nodes it shares with the others, as
// {other realm: {local node: other node}}. Realms and nodes that are not
// loaded here are ignored.
export function validateLinks(data, ids, realms) {
  if (!record(data) || !Object.values(data).every(record))
    throw new Error("The realm links have an unsupported format.");
  const linked = [];
  for (const realm of realms) {
    const entries = data[realm.id];
    if (entries === undefined) continue;
    const links = new Map();
    for (const [id, target] of Object.entries(entries)) {
      if (typeof target !== "string" || !/^[a-zA-Z0-9-]+$/.test(target))
        throw new Error("The realm links contain an invalid node.");
      if (ids.has(id)) links.set(id, target);
    }
    linked.push({ realm, links });
  }
  return linked;
}

// The same subject in other realms, as [{realm, href}].
export function linkedRealms(linked, realms, id) {
  return linked.flatMap(({ realm, links }) => {
    const target = links.get(id);
    return target === undefined
      ? []
      : [{ realm, href: realmHref(realms, realm.id, target) }];
  });
}

export function applyRealm(realm, appName, document) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing interface element: ${id}`);
    node.textContent = value;
    return node;
  };
  document.title = `${realm.name} · ${appName}`;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", realm.description);
  set("source-footer-text", realm.source.footer);
  const footerLink = document.getElementById("source-footer-link");
  footerLink.href = realm.source.url;
  footerLink.setAttribute("aria-label", `Open ${realm.source.name}`);
  set("reader-original", `Original on ${realm.source.shortName} ↗`);
  const paragraphs = realm.about.copyright.map((value) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    return paragraph;
  });
  const terms = document.createElement("a");
  terms.href = realm.source.copyrightUrl;
  terms.target = "_blank";
  terms.rel = "noreferrer";
  terms.textContent = realm.about.copyrightLink;
  paragraphs.at(-1).append(terms, ".");
  document.getElementById("about-copyright").replaceChildren(...paragraphs);
  set("about-common-examples", realm.about.commonTermExamples);
  set("about-subject-note", realm.about.subjectNote);
  const source = set("about-source-link", `${realm.source.name} ↗`);
  source.href = realm.source.url;
  const minimum = document.getElementById("min-mentions");
  minimum.value = String(realm.defaults.minimumMentions);
}
