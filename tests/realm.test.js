import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addressWithRealm,
  chosenRealm,
  dataPath,
  linkedRealms,
  realmHref,
  realmLabel,
  reversedLinks,
  unopenedAddress,
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
  assert.equal(dataPath(realms[1]), "./data/psychology/");
});

test("every address the app writes names its realm, because the default depends on the viewer", () => {
  assert.equal(realmHref("philosophy"), "./?realm=philosophy");
  assert.equal(
    realmHref("psychology", "music-psychology"),
    "./?realm=psychology#/music-psychology",
  );
  assert.equal(addressWithRealm("", "psychology"), "?realm=psychology");
  assert.equal(addressWithRealm("?a=1", "psychology"), "?a=1&realm=psychology");
  // A named realm is kept, including one this viewer cannot open until signing in.
  assert.equal(addressWithRealm("?realm=philosophy", "psychology"), null);
  const arrived = {
    pathname: "/",
    search: "?realm=philosophy",
    hash: "#/nietzsche",
    href: "ignored",
  };
  assert.deepEqual(unopenedAddress(arrived, "psychology"), {
    pathname: "/",
    search: "?realm=philosophy",
    hash: "#/nietzsche",
  });
  assert.equal(unopenedAddress(arrived, "philosophy"), null);
  assert.equal(unopenedAddress({ ...arrived, search: "" }, "psychology"), null);
});

test("the realm list marks the realms that need a signed-in account", () => {
  const entry = {
    id: "philosophy",
    name: "Philosophy",
    source: "SEP",
    sourceShortName: "SEP",
  };
  const realms = validateRealms({
    realms: [
      { ...entry, restricted: true },
      { ...entry, id: "psychology" },
    ],
  });
  assert.deepEqual(
    realms.map((realm) => realm.restricted),
    [true, false],
  );
  assert.throws(
    () => validateRealms({ realms: [{ ...entry, restricted: "yes" }] }),
    /unsupported format/u,
  );
});

test("a restricted realm's links are turned round for the public realm they point at", () => {
  const realms = realmList();
  const restricted = {
    psychology: { love: "love", "music-keyword": "music-psychology" },
    economics: { love: "love-economics" },
  };
  const linked = validateLinks(
    { philosophy: reversedLinks(restricted, "psychology") },
    new Set(["love", "music-psychology"]),
    realms.slice(0, 1),
  );
  assert.deepEqual(linkedRealms(linked, "music-psychology"), [
    { realm: realms[0], href: "./?realm=philosophy#/music-keyword" },
  ]);
  assert.deepEqual(Object.keys(reversedLinks(restricted, "society")), []);
  assert.throws(() => reversedLinks([], "psychology"), /unsupported format/u);
  assert.throws(
    () => reversedLinks({ psychology: { love: 1 } }, "psychology"),
    /invalid node/u,
  );
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
    { realms: [{ ...entry, sourceShortName: undefined }] },
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
  assert.deepEqual(linkedRealms(linked, "keyword-music"), [
    { realm: realms[1], href: "./?realm=psychology#/music-psychology" },
  ]);
  assert.deepEqual(linkedRealms(linked, "gone"), []);
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

test("realms that share a name are told apart by their source", () => {
  const realms = validateRealms({
    realms: [
      {
        id: "philosophy",
        name: "Philosophy",
        source: "Stanford Encyclopedia of Philosophy",
        sourceShortName: "SEP",
      },
      {
        id: "philosophy-wikipedia",
        name: "Philosophy",
        source: "Wikipedia",
        sourceShortName: "Wikipedia",
      },
      {
        id: "psychology",
        name: "Psychology",
        source: "Wikipedia",
        sourceShortName: "Wikipedia",
      },
    ],
  });
  assert.deepEqual(
    realms.map((realm) => realmLabel(realms, realm)),
    ["Philosophy (SEP)", "Philosophy (Wikipedia)", "Psychology"],
  );
});
