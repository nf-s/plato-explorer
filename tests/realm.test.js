import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  chosenRealm,
  dataPath,
  linkedRealms,
  realmHref,
  validateLinks,
  validateRealm,
  validateRealms,
} from "../web/realm.js";

const root = new URL("../", import.meta.url);

async function settings(name) {
  return JSON.parse(
    await readFile(new URL(`realms/${name}/realm.json`, root), "utf8"),
  );
}

function realmList() {
  return validateRealms({
    realms: [
      {
        id: "philosophy",
        name: "Philosophy",
        source: "Stanford Encyclopedia of Philosophy",
        sourceShortName: "SEP",
      },
      {
        id: "psychology",
        name: "Psychology",
        source: "Wikipedia",
        sourceShortName: "Wikipedia",
      },
    ],
  });
}

test("both realms ship valid interface settings with distinct sources", async () => {
  const philosophy = validateRealm(await settings("philosophy"), "philosophy");
  const psychology = validateRealm(await settings("psychology"), "psychology");
  assert.deepEqual(philosophy.source.hosts, ["plato.stanford.edu"]);
  assert.deepEqual(psychology.source.hosts, ["en.wikipedia.org"]);
  assert.notEqual(philosophy.name, psychology.name);
  assert.throws(
    () => validateRealm(philosophy, "psychology"),
    /unsupported format/u,
  );
});

test("realm settings reject missing copy, unsafe links and malformed colours", async () => {
  const valid = await settings("philosophy");
  for (const change of [
    (realm) => delete realm.source.footer,
    (realm) => (realm.source.url = "http://plato.stanford.edu/"),
    (realm) => (realm.source.hosts = []),
    (realm) => (realm.about.copyright = []),
    (realm) => (realm.defaults.minimumMentions = 0),
    (realm) => (realm.subjects[0][1] = "red"),
  ]) {
    const realm = structuredClone(valid);
    change(realm);
    assert.throws(
      () => validateRealm(realm, "philosophy"),
      /unsupported format/u,
    );
  }
});

test("the address chooses a realm and earlier addresses open the default", () => {
  const realms = realmList();
  assert.equal(chosenRealm(realms, "").id, "philosophy");
  assert.equal(chosenRealm(realms, "?realm=psychology").id, "psychology");
  assert.equal(chosenRealm(realms, "?realm=astrology").id, "philosophy");
  assert.equal(realmHref(realms, "philosophy"), "./");
  assert.equal(realmHref(realms, "psychology"), "./?realm=psychology");
  assert.equal(realmHref(realms, "philosophy", "love"), "./#/love");
  assert.equal(
    realmHref(realms, "psychology", "music-psychology"),
    "./?realm=psychology#/music-psychology",
  );
  assert.equal(dataPath(realms[1]), "./data/psychology/");
});

test("the realm list rejects empty, duplicate and unsafe entries", () => {
  const entry = {
    id: "philosophy",
    name: "Philosophy",
    source: "SEP",
    sourceShortName: "SEP",
  };
  for (const data of [
    {},
    { realms: [] },
    { realms: [entry, entry] },
    { realms: [{ ...entry, id: "../secrets" }] },
    { realms: [{ ...entry, name: "" }] },
  ])
    assert.throws(() => validateRealms(data), /unsupported format/u);
});

test("links to other realms open the matching node and ignore unknown nodes and realms", () => {
  const realms = realmList();
  const linked = validateLinks(
    {
      psychology: {
        love: "love",
        "keyword-music": "music-psychology",
        gone: "x",
      },
      economics: { love: "love" },
    },
    new Set(["love", "keyword-music"]),
    realms.slice(1),
  );
  assert.equal(linked.length, 1);
  assert.equal(linked[0].links.size, 2);
  assert.deepEqual(linkedRealms(linked, realms, "keyword-music"), [
    { realm: realms[1], href: "./?realm=psychology#/music-psychology" },
  ]);
  assert.deepEqual(linkedRealms(linked, realms, "gone"), []);
  assert.deepEqual(validateLinks({}, new Set(["love"]), realms.slice(1)), []);
  assert.throws(
    () => validateLinks({ psychology: [] }, new Set(), realms.slice(1)),
    /unsupported format/u,
  );
  assert.throws(
    () =>
      validateLinks(
        { psychology: { a: "b/c" } },
        new Set(["a"]),
        realms.slice(1),
      ),
    /invalid node/u,
  );
});
