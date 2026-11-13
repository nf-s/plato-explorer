"""Locate each explorer's source snapshot, curation files and generated data."""

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITES = ROOT / "sites"
EMPTY_PARTNER = {"name": None, "url": None, "ids": {}}


@dataclass(frozen=True)
class Site:
    name: str
    source: Path
    output: Path
    curation: Path
    people: Path | None
    pages_project: str
    subjects: tuple[str, ...]

    @property
    def config(self):
        return SITES / self.name / "site.json"


def site_names():
    return sorted(path.parent.name for path in SITES.glob("*/build.json"))


def load_site(name):
    if name not in site_names():
        raise SystemExit(f"Unknown site {name!r}; choose one of {', '.join(site_names())}.")
    build = json.loads((SITES / name / "build.json").read_text())
    if not isinstance(build, dict) or set(build) != {"source", "output", "curation", "people", "pagesProject"}:
        raise ValueError(f"Invalid build settings for {name}")
    for field in ("source", "output", "curation", "pagesProject"):
        if not isinstance(build[field], str):
            raise ValueError(f"Invalid {field} for {name}")
    if build["people"] is not None and not isinstance(build["people"], str):
        raise ValueError(f"Invalid people list for {name}")
    web = json.loads((SITES / name / "site.json").read_text())
    subjects = tuple(entry[0] for entry in web["subjects"])
    curation = ROOT / build["curation"]
    return Site(name, ROOT / build["source"], ROOT / build["output"], curation, curation / build["people"] if build["people"] else None, build["pagesProject"], subjects)


def write_site_files(site, output):
    """Copy the interface settings beside the data; keep partner links from an earlier run."""
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(site.config, output / "site.json")
    partner = output / "partner.json"
    if not partner.exists():
        partner.write_text(json.dumps(EMPTY_PARTNER) + "\n")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Refresh data/site.json for one explorer without rebuilding its corpus.")
    parser.add_argument("--site", default="plato", choices=site_names())
    chosen = load_site(parser.parse_args().site)
    write_site_files(chosen, chosen.output)
    print(f"Wrote {chosen.output / 'site.json'}")
