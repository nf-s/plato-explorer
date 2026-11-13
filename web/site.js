// Each deployment ships its own data/site.json; the interface copy that names
// the source encyclopedia comes from there.
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

export function validateSite(data) {
  if (
    !record(data) ||
    !["id", "name", "shortName", "description"].every((field) =>
      text(data[field]),
    ) ||
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
      "The site configuration has an unsupported format. Rebuild the data.",
    );
  return data;
}

// A partner explorer covers another corpus. Its map lists the nodes both share.
export function validatePartner(data, ids) {
  if (!record(data) || !record(data.ids))
    throw new Error("The partner links have an unsupported format.");
  if (data.url === null) return null;
  if (!httpsUrl(data.url) || !text(data.name))
    throw new Error("The partner links have an unsupported format.");
  const links = new Map();
  for (const [id, target] of Object.entries(data.ids)) {
    if (typeof target !== "string" || !/^[a-zA-Z0-9-]+$/.test(target))
      throw new Error("The partner links contain an invalid node.");
    if (ids.has(id)) links.set(id, target);
  }
  return { name: data.name, url: new URL(data.url), links };
}

export function partnerHref(partner, id) {
  const target = partner?.links.get(id);
  if (target === undefined) return null;
  const url = new URL(partner.url);
  url.hash = `#/${encodeURIComponent(target)}`;
  return url.href;
}

export function applySite(site, document) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing interface element: ${id}`);
    node.textContent = value;
    return node;
  };
  document.title = site.name;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", site.description);
  document
    .querySelector('meta[name="apple-mobile-web-app-title"]')
    ?.setAttribute("content", site.shortName);
  set("source-footer-text", site.source.footer);
  const footerLink = document.getElementById("source-footer-link");
  footerLink.href = site.source.url;
  footerLink.setAttribute("aria-label", `Open ${site.source.name}`);
  set("reader-original", `Original on ${site.source.shortName} ↗`);
  const paragraphs = site.about.copyright.map((value) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    return paragraph;
  });
  const terms = document.createElement("a");
  terms.href = site.source.copyrightUrl;
  terms.target = "_blank";
  terms.rel = "noreferrer";
  terms.textContent = site.about.copyrightLink;
  paragraphs.at(-1).append(terms, ".");
  document.getElementById("about-copyright").replaceChildren(...paragraphs);
  set("about-common-examples", site.about.commonTermExamples);
  set("about-subject-note", site.about.subjectNote);
  const source = set("about-source-link", `${site.source.name} ↗`);
  source.href = site.source.url;
  const minimum = document.getElementById("min-mentions");
  minimum.value = String(site.defaults.minimumMentions);
}
