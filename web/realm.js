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

// The realm menu lists the realms this viewer can open; the first is the
// default. A release marks the realms that need a signed-in account.
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
        ) &&
        (entry.restricted === undefined ||
          typeof entry.restricted === "boolean"),
    ) ||
    new Set(data.realms.map((entry) => entry.id)).size !== data.realms.length
  )
    throw new Error("The realm list has an unsupported format.");
  return data.realms.map(
    ({ id, name, source, sourceShortName, restricted }) => ({
      id,
      name,
      source,
      sourceShortName,
      restricted: restricted === true,
    }),
  );
}

// Addresses without a known realm, including those shared before realms
// existed, open the default realm.
export function chosenRealm(realms, search) {
  const requested = new URLSearchParams(search).get("realm");
  return realms.find((realm) => realm.id === requested) ?? realms[0];
}

// The default realm depends on who is looking, so every address the app
// writes names its realm.
export function realmHref(id, nodeId = null) {
  const hash = nodeId === null ? "" : `#/${encodeURIComponent(nodeId)}`;
  return `./?realm=${encodeURIComponent(id)}${hash}`;
}

// An address that names a realm this viewer cannot open, such as a restricted
// realm before signing in. The app then shows the default realm, which drops
// the address's node, so signing in returns to the address as it arrived.
export function unopenedAddress({ pathname, search, hash }, id) {
  const requested = new URLSearchParams(search).get("realm");
  return requested === null || requested === id
    ? null
    : { pathname, search, hash };
}

// An address that names no realm gets the one it opened, so a copied address
// opens the same realm for a viewer with a different default. An address that
// names a realm this viewer cannot open is kept, for signing in.
export function addressWithRealm(search, id) {
  const parameters = new URLSearchParams(search);
  if (parameters.has("realm")) return null;
  parameters.set("realm", id);
  return `?${parameters}`;
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

// A released public realm leaves out its links to restricted realms. The
// restricted realm lists the same pairs from its side, as {its node: local
// node}, which this turns round.
export function reversedLinks(data, id) {
  if (!record(data) || !Object.values(data).every(record))
    throw new Error("The realm links have an unsupported format.");
  const reversed = Object.create(null);
  for (const [target, local] of Object.entries(data[id] ?? {})) {
    if (typeof local !== "string")
      throw new Error("The realm links contain an invalid node.");
    reversed[local] = target;
  }
  return reversed;
}

// The same subject in other realms, as [{realm, href}].
export function linkedRealms(linked, id) {
  return linked.flatMap(({ realm, links }) => {
    const target = links.get(id);
    return target === undefined
      ? []
      : [{ realm, href: realmHref(realm.id, target) }];
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
