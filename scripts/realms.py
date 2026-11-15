"""Locate each realm's source snapshot, curation files and generated data."""

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REALMS = ROOT / "realms"
DATA = ROOT / "web/data"
BUCKET_NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")


@dataclass(frozen=True)
class Realm:
    name: str
    source: Path
    curation: Path
    people: Path | None
    subjects: tuple[str, ...]

    @property
    def config(self):
        return REALMS / self.name / "realm.json"

    @property
    def output(self):
        return DATA / self.name


def app_settings():
    """The Pages project, the bucket that holds released articles and the realms in menu order. The first realm is the default."""
    settings = json.loads((REALMS / "app.json").read_text())
    if not isinstance(settings, dict) or set(settings) != {"pagesProject", "articlesBucket", "realms"} or not isinstance(settings["pagesProject"], str):
        raise ValueError("Invalid app settings")
    if not isinstance(settings["articlesBucket"], str) or not BUCKET_NAME.fullmatch(settings["articlesBucket"]):
        raise ValueError("Invalid articles bucket")
    names = settings["realms"]
    if not isinstance(names, list) or not names or len(set(names)) != len(names) or not all(isinstance(name, str) and (REALMS / name / "build.json").is_file() for name in names):
        raise ValueError("Invalid realm list")
    return settings


def realm_names():
    return app_settings()["realms"]


def load_realm(name):
    if name not in realm_names():
        raise SystemExit(f"Unknown realm {name!r}; choose one of {', '.join(realm_names())}.")
    build = json.loads((REALMS / name / "build.json").read_text())
    if not isinstance(build, dict) or set(build) != {"source", "curation", "people"}:
        raise ValueError(f"Invalid build settings for {name}")
    for field in ("source", "curation"):
        if not isinstance(build[field], str):
            raise ValueError(f"Invalid {field} for {name}")
    if build["people"] is not None and not isinstance(build["people"], str):
        raise ValueError(f"Invalid people list for {name}")
    web = json.loads((REALMS / name / "realm.json").read_text())
    if web["id"] != name:
        raise ValueError(f"realm.json for {name} names another realm")
    subjects = tuple(entry[0] for entry in web["subjects"])
    curation = ROOT / build["curation"]
    return Realm(name, ROOT / build["source"], curation, curation / build["people"] if build["people"] else None, subjects)


def built_realms(data=DATA):
    """Realms whose graph exists under the data directory, in menu order."""
    return [load_realm(name) for name in realm_names() if (data / name / "graph.json").is_file()]


def write_realm_files(realm, output):
    """Copy the interface settings beside the data; keep links to other realms from an earlier run."""
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(realm.config, output / "realm.json")
    links = output / "links.json"
    if not links.exists():
        links.write_text("{}\n")


def realm_index(data=DATA):
    """List the built realms for the app's realm menu."""
    entries = []
    for realm in built_realms(data):
        settings = json.loads(realm.config.read_text())
        entries.append({"id": realm.name, "name": settings["name"], "source": settings["source"]["name"], "sourceShortName": settings["source"]["shortName"]})
    return {"realms": entries}


def write_realm_index(data=DATA):
    index = realm_index(data)
    (data / "realms.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
    return index["realms"]


if __name__ == "__main__":
    for chosen in built_realms():
        write_realm_files(chosen, chosen.output)
    print("Realms: " + ", ".join(entry["id"] for entry in write_realm_index()))
