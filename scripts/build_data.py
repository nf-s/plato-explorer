"""Build the complete local graph and lazily loaded article files from Good One."""

import argparse
import hashlib
import json
import re
import time
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq

from categories import people_ids, subject
from extra_nodes import load_extra_nodes
from layout import communities_and_layout
from text_processing import MentionMatcher, clean_text, resolve_entry

ROOT = Path(__file__).resolve().parents[1]


def string_list(value, context):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{context}: expected a list of strings")
    return value


def records(value, context):
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{context}: expected a list of objects")
    return value


def validate_row(row):
    for field in ("shorturl", "title", "pubinfo"):
        if not isinstance(row.get(field), str):
            raise ValueError(f"Invalid {field}")
    if not re.fullmatch(r"[a-zA-Z0-9-]+", row["shorturl"]) or not row["title"].strip():
        raise ValueError("Article ID or title is invalid")
    for field in ("preamble", "bibliography"):
        string_list(row.get(field), f"{row['shorturl']}.{field}")
    for item in records(row.get("toc"), "toc"):
        clean_text(item.get("content_title"))
        string_list(item.get("sub_toc"), "toc.sub_toc")
    for section in records(row.get("main_text"), "main_text"):
        clean_text(section.get("section_title"))
        string_list(section.get("main_content"), "main_content")
        for subsection in records(section.get("subsections"), "subsections"):
            clean_text(subsection.get("subsection_title"))
            string_list(subsection.get("content"), "subsection.content")
    for entry in records(row.get("related_entries"), "related_entries"):
        clean_text(entry.get("href"))
        clean_text(entry.get("text"))
    return row


def blocks_from_row(row):
    blocks = []

    def append(kind, text):
        text = clean_text(text)
        if text:
            blocks.append({"kind": kind, "text": text, "links": []})

    for paragraph in row["preamble"]:
        append("p", paragraph)
    for section in row["main_text"]:
        append("h2", section["section_title"])
        for paragraph in section["main_content"]:
            append("p", paragraph)
        for subsection in section["subsections"]:
            kind = "h4" if re.match(r"\d+\.\d+\.\d", subsection["subsection_title"]) else "h3"
            append(kind, subsection["subsection_title"])
            for paragraph in subsection["content"]:
                append("p", paragraph)
    return blocks


def attribution_index(path):
    attributions = {}
    if not path.exists():
        return attributions
    with path.open() as stream:
        for line_number, line in enumerate(stream, 1):
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"Invalid JSONL row {line_number}")
            url, content = row.get("url"), row.get("content")
            if not isinstance(url, str) or not isinstance(content, str):
                continue
            article_id = resolve_entry(url, "")
            match = re.search(r"Copyright\s*©\s*(\d{4})\s*by\s*([\s\S]+)", content)
            if article_id and match:
                attribution = match.group(2).strip()
                attribution = re.sub(r"<[^>]*>", "", attribution)
                attribution = clean_text(attribution)
                if len(attribution) < 350:
                    attributions[article_id] = {"year": match.group(1), "authors": attribution}
    return attributions


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def build(source, output):
    started = time.monotonic()
    rows = [validate_row(row) for row in pq.read_table(source).to_pylist()]
    rows.sort(key=lambda row: row["shorturl"])
    ids = {row["shorturl"]: i for i, row in enumerate(rows)}
    canonical_ids = {article_id.lower(): article_id for article_id in ids}
    if len(ids) != len(rows):
        raise ValueError("Duplicate article IDs in the source dataset")
    people = people_ids(ids)
    alias_path = Path(__file__).with_name("aliases.json")
    aliases = json.loads(alias_path.read_text())
    if not isinstance(aliases, dict):
        raise ValueError("Aliases must be an object")
    for article_id, variants in aliases.items():
        string_list(variants, f"aliases.{article_id}")
        if article_id not in ids:
            raise ValueError(f"Alias refers to an unknown article: {article_id}")
    rules = json.loads(Path(__file__).with_name("mention_rules.json").read_text())
    if not isinstance(rules, dict) or set(rules) != {"blocked", "excludedPhrases", "contextual"} or not isinstance(rules["blocked"], dict):
        raise ValueError("Invalid mention rules")
    string_list(rules["excludedPhrases"], "excludedPhrases")
    for article_id, terms in rules["blocked"].items():
        if article_id not in ids:
            raise ValueError(f"Unknown blocked article: {article_id}")
        string_list(terms, f"blocked.{article_id}")
    if not isinstance(rules["contextual"], dict):
        raise ValueError("Invalid contextual name rules")
    for article_id, entry in rules["contextual"].items():
        if not isinstance(entry, dict) or set(entry) != {"aliases", "blockers"}:
            raise ValueError("Invalid contextual name rule")
        string_list(entry["aliases"], f"contextual.{article_id}.aliases")
        string_list(entry["blockers"], f"contextual.{article_id}.blockers")
    titles = {row["shorturl"]: row["title"] for row in rows}
    extras, keyword_audit = load_extra_nodes(rows, titles, aliases)
    for node in extras:
        if node["id"] in ids:
            raise ValueError("Duplicate synthetic node ID")
        ids[node["id"]] = len(ids)
        titles[node["id"]] = node["title"]
        aliases[node["id"]] = node["aliases"]
    for article_id, entry in rules["contextual"].items():
        if article_id not in ids or any(term not in [titles[article_id], *aliases.get(article_id, [])] for term in entry["aliases"]):
            raise ValueError(f"Context rule refers to an unknown target or matched term: {article_id}")
    matcher = MentionMatcher(titles, aliases, rules)
    attributions = attribution_index(source.parent / "stanford-encyclopedia-of-philosophy_dec23.jsonl")
    output.mkdir(parents=True, exist_ok=True)
    article_dir = output / "articles"
    article_dir.mkdir(exist_ok=True)
    nodes, pairs, unresolved, empty_articles = [], {}, [], []
    total_mentions = related_count = 0
    print(f"Processing {len(rows):,} articles from {source.name}…", flush=True)

    def pair(source_index, target_index):
        first, second = sorted((source_index, target_index))
        return pairs.setdefault((first, second), [first, second, 0, 0, 0, 0])

    for source_index, row in enumerate(rows):
        article_id = row["shorturl"]
        blocks = blocks_from_row(row)
        counts = Counter()
        blocked_aliases = matcher.blocked_aliases_for([block["text"] for block in blocks] + row["bibliography"])
        for block in blocks:
            if block["kind"] == "p":
                block["links"], found = matcher.annotate(block["text"], article_id, blocked_aliases)
                counts.update(found)
        for target_id, count in counts.items():
            target_index = ids[target_id]
            edge = pair(source_index, target_index)
            edge[2 if source_index < target_index else 3] = count
            total_mentions += count
        related = []
        seen_related = set()
        for entry in row["related_entries"]:
            target_id = resolve_entry(entry["href"], article_id)
            if target_id:
                target_id = canonical_ids.get(target_id.lower(), target_id)
            title = clean_text(entry["text"])
            identity = target_id or title
            if identity in seen_related:
                continue
            seen_related.add(identity)
            related.append({"title": title, "id": target_id if target_id in ids else None, "url": f"https://plato.stanford.edu/entries/{target_id}/" if target_id else None})
            if target_id in ids and target_id != article_id:
                target_index = ids[target_id]
                edge = pair(source_index, target_index)
                edge[4 if source_index < target_index else 5] = 1
                related_count += 1
            elif target_id != article_id:
                unresolved.append({"source": article_id, "target": target_id, "title": title})
        bibliography = [{"kind": "p", "text": clean_text(text), "links": []} for text in row["bibliography"] if text.strip()]
        url = f"https://plato.stanford.edu/entries/{article_id}/"
        article = {"id": article_id, "title": clean_text(row["title"]), "url": url, "publication": clean_text(row["pubinfo"]), "blocks": blocks, "bibliography": bibliography, "related": related, "sourceToc": row["toc"], "attribution": attributions.get(article_id)}
        write_json(article_dir / f"{article_id}.json", article)
        summary = " ".join(clean_text(text) for text in row["preamble"])
        if not summary:
            summary = next((block["text"] for block in blocks if block["kind"] == "p"), "")
        nodes.append({"id": article_id, "title": article["title"], "summary": summary[:700], "url": url, "aliases": aliases.get(article_id, []), "person": article_id in people, "kind": "person" if article_id in people else "topic", "article": True, "subject": subject(row), "mentions": 0, "references": 0, "degree": 0})
        if not any(block["kind"] == "p" for block in blocks):
            empty_articles.append(article_id)
        if (source_index + 1) % 250 == 0:
            print(f"  {source_index + 1:,} articles processed", flush=True)

    nodes.extend({**node, "mentions": 0, "references": 0, "degree": 0} for node in extras)
    edges = [pairs[pair_key] for pair_key in sorted(pairs)]
    for source_index, target_index, forward, backward, related_forward, related_backward in edges:
        nodes[source_index]["mentions"] += backward
        nodes[target_index]["mentions"] += forward
        nodes[source_index]["references"] += int(backward > 0)
        nodes[target_index]["references"] += int(forward > 0)
        nodes[source_index]["degree"] += 1
        nodes[target_index]["degree"] += 1
    print(f"Laying out {len(edges):,} connections…", flush=True)
    common_terms = {i for i, node in enumerate(nodes) if node["references"] > len(rows) / 2}
    layout_edges = []
    for source_index, target_index, forward, backward, related_forward, related_backward in edges:
        forward = 0 if target_index in common_terms else forward
        backward = 0 if source_index in common_terms else backward
        if forward or backward or related_forward or related_backward:
            layout_edges.append([source_index, target_index, forward, backward, related_forward, related_backward])
    communities = communities_and_layout(nodes, layout_edges)
    meta = {
        "source": source.name, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "articles": len(rows), "nodes": len(nodes), "connections": len(edges), "mentions": total_mentions,
        "relatedLinks": related_count, "unresolvedRelated": len(unresolved),
        "commonTerms": [nodes[i]["id"] for i in sorted(common_terms)],
        "method": "Whole-word, case- and accent-insensitive, longest-first titles, curated aliases and curated synthetic names/keywords. Unicode hyphens normalized; known competing names and senses excluded. Preambles and main paragraphs only; self-mentions, headings, TOCs and bibliographies excluded.",
        "biographies": len(people), "mentionedPeople": sum(node["kind"] == "person" for node in extras), "keywords": sum(node["kind"] == "keyword" for node in extras),
    }
    write_json(output / "graph.json", {"version": 1, "meta": meta, "nodes": nodes, "edges": edges, "communities": communities})
    write_json(output / "word-frequencies.json", keyword_audit.pop("wordFrequencies"))
    write_json(output / "keyword-report.json", keyword_audit)
    write_json(output / "build-report.json", {**meta, "ambiguousTerms": matcher.ambiguous, "unresolvedEntries": unresolved, "emptyArticles": empty_articles, "attributions": len(attributions), "communities": communities})
    print(f"Built {len(rows):,} articles, {len(extras):,} additional nodes, {len(edges):,} connections, {total_mentions:,} mentions and {related_count:,} related-entry links in {time.monotonic() - started:.1f}s.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "data/good-one.parquet")
    parser.add_argument("--output", type=Path, default=ROOT / "web/data")
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve())
