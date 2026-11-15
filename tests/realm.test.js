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
        data: "./data/philosophy/",
      },
      {
        id: "psychology",
        name: "Psychology",
        source: "Wikipedia",
        sourceShortName: "Wikipedia",
        data: "https://realm-data.example/",
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

test("every realm the app lists ships valid interface settings", async () => {
  const app = JSON.parse(
    await readFile(new URL("realms/app.json", root), "utf8"),
  );
  assert.ok(app.realms.length >= 2);
  for (const id of app.realms)
    assert.equal(validateRealm(await settings(id), id).id, id);
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
  assert.equal(dataPath(realms[0]), "./data/philosophy/");
  assert.equal(dataPath(realms[1]), "https://realm-data.example/");
});

test("the realm list rejects empty, duplicate and unsafe entries", () => {
  const entry = {
    id: "philosophy",
    name: "Philosophy",
    source: "SEP",
    sourceShortName: "SEP",
    data: "./data/philosophy/",
  };
  for (const data of [
    {},
    { realms: [] },
    { realms: [entry, entry] },
    { realms: [{ ...entry, id: "../secrets" }] },
    { realms: [{ ...entry, name: "" }] },
    { realms: [{ ...entry, data: "./data/psychology/" }] },
    { realms: [{ ...entry, data: "http://realm-data.example/" }] },
    { realms: [{ ...entry, data: "https://realm-data.example/data" }] },
    { realms: [{ ...entry, data: undefined }] },
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
