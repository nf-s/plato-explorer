"""Curated non-article nodes and reproducible corpus-wide word frequencies."""

import json
import re
from collections import Counter
from pathlib import Path

from categories import SUBJECT_TERMS
from text_processing import clean_text, key, matching_text, regex_trie

INVENTORY = Path(__file__).with_name("extra_nodes.json")
WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)
SUBJECTS = set(SUBJECT_TERMS) | {"Other / interdisciplinary"}


def paragraphs(row):
    """Use the same preamble and main paragraphs as the graph matcher."""
    yield from row["preamble"]
    for section in row["main_text"]:
        yield from section["main_content"]
        for subsection in section["subsections"]:
            yield from subsection["content"]


def validate_inventory(records):
    if not isinstance(records, list):
        raise ValueError("Extra nodes must be a list")
    ids = set()
    terms = set()
    for record in records:
        if not isinstance(record, dict) or set(record) != {"id", "title", "kind", "aliases", "subject"}:
            raise ValueError("Invalid extra-node fields")
        article_id = record["id"]
        if not isinstance(article_id, str) or not re.fullmatch(r"(?:keyword|person)-[a-z0-9-]+", article_id) or article_id in ids:
            raise ValueError("Duplicate or invalid extra-node ID")
        if not isinstance(record["kind"], str) or record["kind"] not in {"keyword", "person"} or not article_id.startswith(record["kind"] + "-"):
            raise ValueError("Extra-node kind does not match its ID")
        if not isinstance(record["title"], str) or len(key(record["title"])) < 3 or not isinstance(record["subject"], str) or record["subject"] not in SUBJECTS:
            raise ValueError("Invalid extra-node title or subject")
        aliases = record["aliases"]
        if not isinstance(aliases, list) or any(not isinstance(alias, str) or len(key(alias)) < 3 for alias in aliases):
            raise ValueError("Invalid extra-node aliases")
        local = [key(record["title"]), *(key(alias) for alias in aliases)]
        if len(set(local)) != len(local) or any(term in terms for term in local):
            raise ValueError("Duplicate extra-node term")
        ids.add(article_id)
        terms.update(local)
    return records


def load_extra_nodes(rows, titles, aliases, inventory_path=INVENTORY):
    """Return (nodes, audit); generated nodes never pretend to have SEP articles."""
    inventory = validate_inventory(json.loads(Path(inventory_path).read_text()))
    known_terms = {key(title) for title in titles.values()}
    known_terms.update(key(title[4:]) for title in titles.values() if title.lower().startswith("the "))
    known_terms.update(key(alias) for values in aliases.values() for alias in values)
    candidates = []
    rejected = []
    for record in inventory:
        record_terms = [key(record["title"]), *(key(alias) for alias in record["aliases"])]
        covered = [term for term in record_terms if term in known_terms]
        if record["id"] in titles:
            raise ValueError("Extra-node ID collides with an article")
        if covered:
            rejected.append({"id": record["id"], "reason": "already represented by an article title or alias", "terms": sorted(set(covered))})
        else:
            candidates.append(record)
    targets = {key(term): record["id"] for record in candidates for term in [record["title"], *record["aliases"]]}
    pattern = regex_trie(targets) if targets else re.compile(r"(?!)")
    words = Counter()
    word_articles = Counter()
    mentions = Counter()
    sources = {record["id"]: set() for record in candidates}
    examples = {record["id"]: [] for record in candidates}
    for row in rows:
        article_words = set()
        for raw in paragraphs(row):
            text = clean_text(raw)
            normalized = key(text)
            terms = WORD.findall(normalized)
            words.update(terms)
            article_words.update(terms)
            for match in pattern.finditer(normalized):
                target = targets.get(match.group())
                if target is None:
                    continue
                mentions[target] += 1
                sources[target].add(row["shorturl"])
                if len(examples[target]) < 3 and not any(example["source"] == row["shorturl"] for example in examples[target]):
                    _, starts, ends = matching_text(text)
                    start = starts[match.start()] if starts is not None else match.start()
                    end = ends[match.end() - 1] if ends is not None else match.end()
                    examples[target].append({"source": row["shorturl"], "text": text[max(0, start - 70):end + 100]})
        word_articles.update(article_words)
    nodes = []
    accepted = []
    for record in candidates:
        article_id = record["id"]
        if len(sources[article_id]) < 2:
            rejected.append({"id": article_id, "reason": "fewer than two source articles", "mentions": mentions[article_id], "articles": len(sources[article_id])})
            continue
        person = record["kind"] == "person"
        nodes.append({**record, "article": False, "person": person, "url": None, "summary": "Person mentioned in the supplied articles; no dedicated article in this snapshot." if person else "Keyword found in the supplied articles; no dedicated article under this title in this snapshot."})
        accepted.append({"id": article_id, "title": record["title"], "kind": record["kind"], "mentions": mentions[article_id], "articles": len(sources[article_id]), "examples": examples[article_id]})
    frequencies = [{"word": word, "count": count, "articles": word_articles[word]} for word, count in sorted(words.items(), key=lambda item: (-item[1], item[0]))]
    audit = {"articlesScanned": len(rows), "totalWords": sum(words.values()), "distinctWords": len(words), "wordFrequencies": frequencies, "accepted": accepted, "rejected": rejected, "method": "Alphabetic word tokens from preambles and main paragraphs, including internal apostrophes; normalized with the graph matcher's key. Counts exclude headings, bibliographies and self-generated text. Candidate counts precede longest-title competition with real articles; final graph counts are authoritative."}
    return nodes, audit
