"""Choose the article set from candidate links: add well-linked neighbours, drop isolated candidates."""

import argparse
import bz2
import gzip
import html
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "data/wikipedia"
ARTICLE_PREFIX = "https://en.wikipedia.org/wiki/"
TITLE_INDEX = "enwiki-latest-pages-articles-multistream-index.txt.bz2"
REDIRECT_TABLE = "enwiki-latest-redirect.sql.gz"
REDIRECT_ROW = re.compile(r"\((\d+),(-?\d+),'((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)','(?:[^'\\]|\\.)*'\)")
NAMESPACES = {"file", "image", "category", "help", "wikipedia", "template", "special", "portal", "talk", "user", "draft", "module", "wp", "wikt", "s", "commons"}
# Reference lists and reading lists link to works and publishers, not to the subject.
REFERENCE_SECTIONS = {"references", "external links", "further reading", "notes", "bibliography", "sources", "citations", "footnotes", "works cited", "publications", "selected publications", "selected works", "selected bibliography", "books", "works"}
CORE_IMPORTANCE = {"Top", "High", "Mid"}


def link_title(url):
    """Return the article title a link points to, or None for other namespaces and sites."""
    if not isinstance(url, str) or not url.startswith(ARTICLE_PREFIX):
        return None
    title = unquote(url[len(ARTICLE_PREFIX):]).split("#")[0].replace("_", " ").strip()
    if not title or title.split(":")[0].lower() in NAMESPACES:
        return None
    return title[0].upper() + title[1:]


def text_parts(parts, references=False):
    """Yield (part, in_reference_section) for paragraphs and list items, depth first."""
    for part in parts:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        inside = references or (kind == "section" and str(part.get("name", "")).strip().lower() in REFERENCE_SECTIONS)
        if kind in ("paragraph", "list_item") and isinstance(part.get("value"), str):
            yield part, inside
        yield from text_parts(part.get("has_parts") or [], inside)


def read_articles(path):
    with path.open() as stream:
        for line in stream:
            yield json.loads(line)


def outgoing_titles(article):
    titles = set()
    for part, references in text_parts(article["sections"]):
        if references:
            continue
        for link in part.get("links") or []:
            title = link_title(link.get("url")) if isinstance(link, dict) else None
            if title:
                titles.add(title)
    titles.discard(article["name"])
    return titles


def resolve_redirects(titles, snapshot):
    """Map link titles that are not article names to the articles they redirect to.

    The answers come from two Wikimedia dump files: the title index gives each page's ID
    and the redirect table gives each redirecting page's target."""
    cache_path = snapshot / "redirects.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    missing = {title for title in titles if title not in cache}
    if not missing:
        return cache
    for name in (TITLE_INDEX, REDIRECT_TABLE):
        if not (snapshot / name).exists():
            raise SystemExit(f"Download {name} to {snapshot}; see docs/psychology.md.")
    page_titles = {}
    with bz2.open(snapshot / TITLE_INDEX, "rt", encoding="utf-8") as stream:
        for line in stream:
            _, page_id, title = line.rstrip("\n").split(":", 2)
            title = html.unescape(title)
            if title in missing:
                page_titles[int(page_id)] = title
    found = dict.fromkeys(missing)
    with gzip.open(snapshot / REDIRECT_TABLE, "rt", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            for page_id, namespace, target, interwiki in REDIRECT_ROW.findall(line):
                title = page_titles.get(int(page_id))
                if title is not None and namespace == "0" and not interwiki:
                    found[title] = re.sub(r"\\(.)", r"\1", target).replace("_", " ")
    cache.update(found)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False) + "\n")
    return cache


class LinkResolver:
    """Follow link titles to snapshot article names, asking Wikipedia about redirects once."""

    def __init__(self, snapshot):
        # Imported here so the link functions load without the Parquet library.
        import pyarrow.parquet as pq

        self.known = set(pq.read_table(snapshot / "index.parquet", columns=["name"])["name"].to_pylist())
        self.snapshot = snapshot
        self.redirects = {}

    def learn(self, titles):
        self.redirects = resolve_redirects({title for title in titles if title not in self.known}, self.snapshot)

    def resolve(self, title):
        if title in self.known:
            return title
        target = self.redirects.get(title)
        return target if target in self.known else None


class LinkGraph:
    """Outgoing article links with redirects followed, for articles copied from the snapshot."""

    def __init__(self, articles, snapshot):
        resolver = LinkResolver(snapshot)
        raw = {article["name"]: outgoing_titles(article) for article in articles}
        resolver.learn({title for titles in raw.values() for title in titles})
        self.outgoing = {}
        for name, titles in raw.items():
            resolved = {resolver.resolve(title) for title in titles}
            resolved.discard(None)
            resolved.discard(name)
            self.outgoing[name] = resolved

    def incoming_counts(self, sources):
        return Counter(title for name in sources for title in self.outgoing[name])


def expand(candidates_path, articles_path, snapshot, minimum_links, output):
    """List articles outside the candidates that at least `minimum_links` candidates link to."""
    candidates = json.loads(candidates_path.read_text())
    graph = LinkGraph(read_articles(articles_path), snapshot)
    incoming = graph.incoming_counts(graph.outgoing)
    neighbours = sorted(title for title, count in incoming.items() if count >= minimum_links and title not in candidates)
    output.write_text(json.dumps(neighbours, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(neighbours):,} outside articles are linked from at least {minimum_links} candidates; wrote {output}", flush=True)


def select(candidates_path, article_paths, snapshot, minimum_incoming, minimum_seed_links, minimum_neighbour_links, minimum_share, output):
    """Keep core-rated articles and the rest of the field that trusted articles link to.

    WikiProject ratings and occupations are trusted. Wikidata class trees are not: they reach
    anthems and medicines through loose subclass chains, so those articles, like linked
    neighbours, must also keep enough of their own links inside the field."""
    candidates = json.loads(candidates_path.read_text())
    articles = [article for path in article_paths for article in read_articles(path)]
    graph = LinkGraph(articles, snapshot)
    trusted = [name for name in graph.outgoing if name in candidates and (candidates[name]["importance"] or candidates[name]["person"])]
    incoming = graph.incoming_counts(trusted)
    kept = {name for name in trusted if candidates[name]["importance"] in CORE_IMPORTANCE or incoming[name] >= minimum_incoming}
    selected = {}
    for name in sorted(graph.outgoing):
        links = graph.outgoing[name]
        share = len(links & kept) / len(links) if links else 0.0
        entry = {"incoming": incoming[name], "share": round(share, 3)}
        if name in kept:
            selected[name] = {**candidates[name], **entry, "reason": "rated" if candidates[name]["importance"] else "occupation"}
        elif name in candidates and name not in trusted:
            if incoming[name] >= minimum_seed_links and share >= minimum_share:
                selected[name] = {**candidates[name], **entry, "reason": "class"}
        elif name not in candidates and incoming[name] >= minimum_neighbour_links and share >= minimum_share:
            selected[name] = {"importance": None, "seeds": [], "person": False, **entry, "reason": "linked"}
    output.write_text(json.dumps(selected, ensure_ascii=False, indent=1) + "\n")
    reasons = Counter(entry["reason"] for entry in selected.values())
    print(f"Selected {len(selected):,} articles: " + ", ".join(f"{count:,} {reason}" for reason, count in sorted(reasons.items())) + f"; wrote {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=SNAPSHOT)
    commands = parser.add_subparsers(dest="command", required=True)
    grow = commands.add_parser("expand")
    grow.add_argument("--minimum-links", type=int, default=10)
    choose = commands.add_parser("select")
    choose.add_argument("--minimum-incoming", type=int, default=3, help="links from trusted articles that keep a low-rated article or a person")
    choose.add_argument("--minimum-seed-links", type=int, default=3, help="links from trusted articles that a Wikidata class member needs")
    choose.add_argument("--minimum-neighbour-links", type=int, default=10, help="links from trusted articles that an outside article needs")
    choose.add_argument("--minimum-share", type=float, default=0.2, help="share of an untrusted article's own links that must stay in the field")
    args = parser.parse_args()
    snapshot = args.snapshot.resolve()
    if args.command == "expand":
        expand(snapshot / "candidates.json", snapshot / "candidates.jsonl", snapshot, args.minimum_links, snapshot / "neighbours.json")
    else:
        select(snapshot / "candidates.json", [snapshot / "candidates.jsonl", snapshot / "neighbours.jsonl"], snapshot, args.minimum_incoming, args.minimum_seed_links, args.minimum_neighbour_links, args.minimum_share, snapshot / "selected.json")
