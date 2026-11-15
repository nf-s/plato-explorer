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


def build(config, output):
    scope = json.loads(config.read_text())
    cache = output.parent / "scope-cache"
    titles = {}
    for importance in scope["wikiProject"]["importance"]:
        category = scope["wikiProject"]["category"].format(importance=importance)
        found, _ = cached(cache, category, lambda: list(category_titles(category)))
        for title in found:
            titles.setdefault(title, {"importance": importance, "seeds": [], "person": False})
        print(f"{importance}-importance: {len(found):,} articles", flush=True)
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
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(titles, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    print(f"Wrote {len(titles):,} candidate titles to {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "realms/psychology/scope.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/wikipedia/candidates.json")
    args = parser.parse_args()
    build(args.config.resolve(), args.output.resolve())
