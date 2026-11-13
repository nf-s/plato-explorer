import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { partnerHref, validatePartner, validateSite } from "../web/site.js";

const root = new URL("../", import.meta.url);

async function settings(name) {
  return JSON.parse(
    await readFile(new URL(`sites/${name}/site.json`, root), "utf8"),
  );
}

test("both explorers ship valid interface settings with distinct sources", async () => {
  const plato = validateSite(await settings("plato"));
  const psychology = validateSite(await settings("psychology"));
  assert.deepEqual(plato.source.hosts, ["plato.stanford.edu"]);
  assert.deepEqual(psychology.source.hosts, ["en.wikipedia.org"]);
  assert.notEqual(plato.name, psychology.name);
});

test("site settings reject missing copy, unsafe links and malformed colours", async () => {
  const valid = await settings("plato");
  for (const change of [
    (site) => delete site.source.footer,
    (site) => (site.source.url = "http://plato.stanford.edu/"),
    (site) => (site.source.hosts = []),
    (site) => (site.about.copyright = []),
    (site) => (site.defaults.minimumMentions = 0),
    (site) => (site.subjects[0][1] = "red"),
  ]) {
    const site = structuredClone(valid);
    change(site);
    assert.throws(() => validateSite(site), /unsupported format/u);
  }
});

test("partner links open the matching node and ignore unknown local nodes", () => {
  const ids = new Set(["love", "keyword-music"]);
  const partner = validatePartner(
    {
      name: "Psychology Explorer",
      url: "https://example.org/",
      ids: { love: "love", "keyword-music": "music-psychology", gone: "x" },
    },
    ids,
  );
  assert.equal(partner.links.size, 2);
  assert.equal(partnerHref(partner, "love"), "https://example.org/#/love");
  assert.equal(
    partnerHref(partner, "keyword-music"),
    "https://example.org/#/music-psychology",
  );
  assert.equal(partnerHref(partner, "gone"), null);
  assert.equal(partnerHref(null, "love"), null);
});

test("an explorer without a partner address shows no partner links", () => {
  assert.equal(
    validatePartner({ name: null, url: null, ids: {} }, new Set()),
    null,
  );
  assert.throws(
    () =>
      validatePartner(
        { name: "Other", url: "javascript:alert(1)", ids: {} },
        new Set(),
      ),
    /unsupported format/u,
  );
  assert.throws(
    () =>
      validatePartner(
        { name: "Other", url: "https://example.org/", ids: { a: "b/c" } },
        new Set(["a"]),
      ),
    /invalid node/u,
  );
});
