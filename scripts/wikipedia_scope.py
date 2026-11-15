"""List candidate English Wikipedia articles from WikiProject ratings and Wikidata classes."""

import argparse
import json
import re
import time
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "explorer-corpus-builder/0.1 (local research script)"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
SNAPSHOT = ROOT / "data/wikipedia"
IMPORTANCE = ["Top", "High", "Mid", "Low"]
# Some WikiProjects rate quality and not importance. Their articles are nominated at the
# lowest importance, so each still needs links from the field to be kept.
QUALITY = ["FA", "GA", "B", "C", "Start", "Stub"]
QUALITY_IMPORTANCE = "Low"
SCOPE_FIELDS = {"wikiProjects", "importance", "wikidataSeeds", "selection", "subjects"}
SELECTION = ("expandLinks", "incoming", "seedLinks", "neighbourLinks", "share")


def get_json(url, parameters, attempts=6):
    request = Request(f"{url}?{urlencode(parameters)}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=180) as response:
                return json.load(response)
        except (HTTPError, URLError, HTTPException, TimeoutError, json.JSONDecodeError) as error:
            if attempt == attempts - 1:
                raise RuntimeError(f"Request failed after {attempts} attempts: {error}") from error
            time.sleep(65 if url == WIKIDATA_SPARQL else 5 * (attempt + 1))
    raise RuntimeError("Request failed")


def category_titles(category):
    """Yield article titles whose talk pages are in a WikiProject assessment category."""
    parameters = {"action": "query", "list": "categorymembers", "cmtitle": f"Category:{category}", "cmnamespace": "1", "cmlimit": "500", "format": "json", "formatversion": "2"}
    while True:
        data = get_json(WIKIPEDIA_API, parameters)
        for member in data["query"]["categorymembers"]:
            title = member["title"]
            if isinstance(title, str) and title.startswith("Talk:"):
                yield title[5:]
        if "continue" not in data:
            return
        parameters = {**parameters, **data["continue"]}
        time.sleep(0.2)


def seed_titles(pattern):
    """Return the English Wikipedia titles of items matching one Wikidata graph pattern."""
    query = f"SELECT DISTINCT ?title WHERE {{ {pattern} . ?page schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title }}"
    data = get_json(WIKIDATA_SPARQL, {"query": query, "format": "json"})
    return sorted(row["title"]["value"] for row in data["results"]["bindings"])


def cached(directory, name, fetch):
    """Keep each completed request so an interrupted run resumes without repeating it."""
    path = directory / (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + ".json")
    if path.exists():
        return json.loads(path.read_text()), True
    values = fetch()
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values, ensure_ascii=False) + "\n")
    return values, False


def load_scope(realm):
    """Read realms/<realm>/scope.json: where candidates come from, how they are selected and how subjects are estimated."""
    scope = json.loads((ROOT / "realms" / realm / "scope.json").read_text())
    if not isinstance(scope, dict) or not SCOPE_FIELDS <= set(scope) <= SCOPE_FIELDS | {"quality"}:
        raise ValueError(f"Invalid scope for {realm}")
    # Each category names one rating: "{importance}-importance X articles" or "{quality}-Class X articles".
    if not scope["wikiProjects"] or not all(isinstance(category, str) and ("{importance}" in category) != ("{quality}" in category) for category in scope["wikiProjects"]):
        raise ValueError(f"Invalid WikiProject categories for {realm}")
    if not scope["importance"] or not set(scope["importance"]) <= set(IMPORTANCE):
        raise ValueError(f"Invalid importance levels for {realm}")
    by_quality = any("{quality}" in category for category in scope["wikiProjects"])
    if by_quality != bool(scope.get("quality")) or not set(scope.get("quality", [])) <= set(QUALITY):
        raise ValueError(f"Invalid quality classes for {realm}")
    for seed in scope["wikidataSeeds"]:
        if not isinstance(seed, dict) or set(seed) != {"name", "pattern", "person"} or not isinstance(seed["person"], bool):
            raise ValueError(f"Invalid Wikidata seed for {realm}")
    if set(scope["selection"]) != set(SELECTION) or not all(isinstance(value, (int, float)) for value in scope["selection"].values()):
        raise ValueError(f"Invalid selection thresholds for {realm}")
    seeds = {seed["name"] for seed in scope["wikidataSeeds"]}
    for entry in scope["subjects"].values():
        if not isinstance(entry, dict) or set(entry) != {"terms", "seeds"} or not isinstance(entry["terms"], str) or not set(entry["seeds"]) <= seeds:
            raise ValueError(f"Invalid subject for {realm}")
    return scope


def rated_categories(scope):
    """Yield each assessment category with the importance its articles are nominated at."""
    for template in scope["wikiProjects"]:
        if "{quality}" in template:
            for quality in scope["quality"]:
                yield template.format(quality=quality), QUALITY_IMPORTANCE
        else:
            for importance in scope["importance"]:
                yield template.format(importance=importance), importance


def work_directory(realm, snapshot=SNAPSHOT):
    """Each realm keeps its candidate lists and copied articles in its own folder beside the snapshot."""
    return snapshot / realm


def build(realm, snapshot=SNAPSHOT):
    scope = load_scope(realm)
    work = work_directory(realm, snapshot)
    cache = work / "scope-cache"
    titles = {}
    for category, importance in rated_categories(scope):
        found, _ = cached(cache, category, lambda: list(category_titles(category)))
        for title in found:
            entry = titles.setdefault(title, {"importance": importance, "seeds": [], "person": False})
            # An article rated by several projects keeps its highest rating.
            if IMPORTANCE.index(importance) < IMPORTANCE.index(entry["importance"]):
                entry["importance"] = importance
        print(f"{category}: {len(found):,} articles", flush=True)
    for seed in scope["wikidataSeeds"]:
        found, reused = cached(cache, "wikidata " + seed["name"], lambda: seed_titles(seed["pattern"]))
        for title in found:
            entry = titles.setdefault(title, {"importance": None, "seeds": [], "person": False})
            entry["seeds"].append(seed["name"])
            # An occupation is recorded only for people, so these classes do not leak.
            entry["person"] = entry["person"] or seed["person"]
        print(f"{seed['name']}: {len(found):,} articles", flush=True)
        if not reused:
            # The public query service has been limiting clients to one request per minute.
            time.sleep(65)
    work.mkdir(parents=True, exist_ok=True)
    output = work / "candidates.json"
    output.write_text(json.dumps(titles, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    print(f"Wrote {len(titles):,} candidate titles to {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--realm", required=True)
    build(parser.parse_args().realm)
