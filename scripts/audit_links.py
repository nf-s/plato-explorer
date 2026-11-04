"""Audit every generated article link and compare the graph with a saved baseline."""

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from text_processing import key

ROOT = Path(__file__).resolve().parents[1]


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def read_graph(path):
    graph = json.loads(path.read_text())
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("edges"), list):
        raise ValueError("Invalid graph structure")
    nodes = {}
    for node in graph["nodes"]:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9-]+", node["id"]) or node["id"] in nodes:
            raise ValueError("Invalid or duplicate graph node")
        if not isinstance(node.get("title"), str) or not isinstance(node.get("article", True), bool):
            raise ValueError("Invalid node metadata")
        aliases = node.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(alias, str) for alias in aliases):
            raise ValueError("Invalid node aliases")
        nodes[node["id"]] = node
    directed, related, pairs = Counter(), set(), set()
    for edge in graph["edges"]:
        if not isinstance(edge, list) or len(edge) != 6 or any(not integer(value) for value in edge):
            raise ValueError("Invalid graph edge")
        a, b, forward, backward, related_forward, related_backward = edge
        if a >= b or b >= len(graph["nodes"]) or related_forward > 1 or related_backward > 1 or not any(edge[2:]):
            raise ValueError("Invalid graph edge endpoints or counts")
        first, second = graph["nodes"][a]["id"], graph["nodes"][b]["id"]
        pair = tuple(sorted((first, second)))
        if pair in pairs:
            raise ValueError("Duplicate graph edge")
        pairs.add(pair)
        if forward:
            directed[first, second] = forward
        if backward:
            directed[second, first] = backward
        if related_forward:
            related.add((first, second))
        if related_backward:
            related.add((second, first))
    return graph, nodes, directed, related, pairs


def metrics(nodes, directed, pairs):
    values = {article_id: {"mentions": 0, "references": 0, "degree": 0} for article_id in nodes}
    for (_, target), count in directed.items():
        values[target]["mentions"] += count
        values[target]["references"] += 1
    for first, second in pairs:
        values[first]["degree"] += 1
        values[second]["degree"] += 1
    return values


def compare_directions(before, after, allowed):
    old = {pair: count for pair, count in before.items() if set(pair) <= allowed}
    new = {pair: count for pair, count in after.items() if set(pair) <= allowed}
    changes = []
    added_mentions = removed_mentions = 0
    for source, target in old.keys() | new.keys():
        previous, current = old.get((source, target), 0), new.get((source, target), 0)
        if previous == current:
            continue
        delta = current - previous
        added_mentions += max(0, delta)
        removed_mentions += max(0, -delta)
        changes.append({"source": source, "target": target, "before": previous, "after": current, "delta": delta})
    changes.sort(key=lambda item: (-abs(item["delta"]), item["source"], item["target"]))
    return {
        "mentionsBefore": sum(old.values()), "mentionsAfter": sum(new.values()),
        "addedMentions": added_mentions, "removedMentions": removed_mentions,
        "addedDirectedPairs": len(new.keys() - old.keys()), "removedDirectedPairs": len(old.keys() - new.keys()),
        "changedDirectedPairs": len(changes), "largestChanges": changes[:100],
    }


def audit(baseline, data_dir, aliases_path=ROOT / "scripts/aliases.json"):
    _, before_nodes, before_directed, _, before_pairs = read_graph(baseline)
    graph, nodes, expected, expected_related, pairs = read_graph(data_dir / "graph.json")
    aliases = json.loads(aliases_path.read_text())
    if not isinstance(aliases, dict) or any(not isinstance(variants, list) or any(not isinstance(alias, str) for alias in variants) for variants in aliases.values()):
        raise ValueError("Invalid configured aliases")
    before_metrics = metrics(before_nodes, before_directed, before_pairs)
    after_metrics = metrics(nodes, expected, pairs)
    real_ids = {article_id for article_id, node in nodes.items() if node.get("article", True)}
    if graph.get("meta", {}).get("articles", len(real_ids)) != len(real_ids):
        raise ValueError("Real article count disagrees with graph metadata")
    shared_ids = real_ids & before_nodes.keys()
    gains = sorted(nodes, key=lambda article_id: (-(after_metrics[article_id]["mentions"] - before_metrics.get(article_id, {}).get("mentions", 0)), article_id))
    example_targets = set(gains[:50]) | ({"meister-eckhart"} & nodes.keys())
    actual, actual_related, forms = Counter(), set(), defaultdict(Counter)
    examples = defaultdict(list)
    paragraphs = paragraphs_with_links = text_characters = link_count = 0
    reviewed = []
    for article_id in sorted(real_ids):
        article = json.loads((data_dir / "articles" / f"{article_id}.json").read_text())
        if not isinstance(article, dict) or article.get("id") != article_id or not isinstance(article.get("blocks"), list) or not isinstance(article.get("bibliography"), list) or not isinstance(article.get("related"), list):
            raise ValueError(f"Invalid article: {article_id}")
        reviewed.append(article_id)
        section = "Introduction"
        for block_index, block in enumerate(article["blocks"]):
            if not isinstance(block, dict) or not isinstance(block.get("text"), str) or not isinstance(block.get("links"), list) or block.get("kind") not in {"p", "h2", "h3", "h4", "li", "quote"}:
                raise ValueError(f"Invalid text block: {article_id}")
            if block["kind"].startswith("h"):
                section = block["text"]
            if block["kind"] != "p":
                if block["links"]:
                    raise ValueError(f"Non-paragraph link counted: {article_id}")
                continue
            paragraphs += 1
            paragraphs_with_links += bool(block["links"])
            text_characters += len(block["text"])
            encoded = block["text"].encode("utf-16-le")
            previous_end = 0
            for link in block["links"]:
                if not isinstance(link, list) or len(link) != 3:
                    raise ValueError(f"Invalid link: {article_id}")
                start, end, target = link
                if not integer(start) or not integer(end) or start < previous_end or start >= end or end * 2 > len(encoded) or not isinstance(target, str) or target not in nodes or target == article_id:
                    raise ValueError(f"Invalid link span or target: {article_id}")
                try:
                    original = encoded[start * 2:end * 2].decode("utf-16-le")
                except UnicodeDecodeError as error:
                    raise ValueError(f"Link splits a Unicode character: {article_id}") from error
                if not original.strip():
                    raise ValueError(f"Empty linked text: {article_id}")
                previous_end = end
                actual[article_id, target] += 1
                forms[target][original] += 1
                link_count += 1
                if target in example_targets and len(examples[target]) < 5:
                    prefix = encoded[:start * 2].decode("utf-16-le")
                    position = len(prefix)
                    examples[target].append({"source": article_id, "section": section, "block": block_index, "text": original, "excerpt": block["text"][max(0, position - 100):position + len(original) + 160]})
        for block in article["bibliography"]:
            if not isinstance(block, dict) or not isinstance(block.get("text"), str) or block.get("links") != []:
                raise ValueError(f"Bibliography contains invalid data or links: {article_id}")
        for entry in article["related"]:
            if not isinstance(entry, dict) or (entry.get("id") is not None and entry.get("id") not in nodes):
                raise ValueError(f"Invalid related entry: {article_id}")
            if entry.get("id") and entry["id"] != article_id:
                actual_related.add((article_id, entry["id"]))
    if actual != expected:
        mismatch = next(pair for pair in actual.keys() | expected.keys() if actual[pair] != expected[pair])
        raise ValueError(f"Article links disagree with graph counts: {mismatch}: {actual[mismatch]} versus {expected[mismatch]}")
    if actual_related != expected_related:
        raise ValueError("Article related entries disagree with graph edges")
    for article_id, node in nodes.items():
        for field, count in after_metrics[article_id].items():
            if node.get(field) != count:
                raise ValueError(f"Node {field} disagrees with graph: {article_id}")
    node_changes = []
    for article_id in sorted(nodes):
        node = nodes[article_id]
        old = before_metrics.get(article_id)
        new = after_metrics[article_id]
        configured = {key(alias) for alias in aliases.get(article_id, [])}
        old_aliases = {key(alias) for alias in before_nodes.get(article_id, {}).get("aliases", [])}
        added_aliases = sorted({alias for alias in aliases.get(article_id, []) if key(alias) not in old_aliases})
        if old == new and not added_aliases:
            continue
        item = {
            "id": article_id, "title": node["title"], "article": article_id in real_ids,
            "kind": node.get("kind", "article"), "before": old, "after": new,
            "addedAliases": added_aliases,
            "matchedForms": [{"text": term, "normalized": key(term), "count": count, "configuredAlias": key(term) in configured} for term, count in forms[article_id].most_common(10)],
        }
        if article_id in examples:
            item["currentExamples"] = examples[article_id]
        node_changes.append(item)
    original_pairs = {pair for pair in before_pairs if set(pair) <= shared_ids}
    current_pairs = {pair for pair in pairs if set(pair) <= shared_ids}
    extras = {}
    for label, person in [("people", True), ("keywords", False)]:
        selected = {article_id for article_id, node in nodes.items() if article_id not in real_ids and bool(node.get("person")) == person}
        extras[label] = {"nodes": len(selected), "mentions": sum(after_metrics[article_id]["mentions"] for article_id in selected), "connections": sum(bool(set(pair) & selected) for pair in pairs), "ids": sorted(selected)}
    return {
        "version": 1, "coverage": {"articles": len(reviewed), "expectedArticles": len(real_ids), "articleIds": reviewed, "paragraphs": paragraphs, "paragraphsWithLinks": paragraphs_with_links, "textCharacters": text_characters, "validatedLinks": link_count, "relatedLinks": len(actual_related)},
        "articleConnections": {"before": len(original_pairs), "after": len(current_pairs), "added": len(current_pairs - original_pairs), "removed": len(original_pairs - current_pairs)},
        "articleMentions": compare_directions(before_directed, actual, shared_ids),
        "additionalNodes": extras, "changedNodes": node_changes,
        "notes": ["Every real article and main paragraph was scanned; stored UTF-16 links exactly match directed graph counts.", "Examples show current links for targets whose counts increased; a graph-only baseline cannot prove the history of an individual text span.", "Article-to-article changes are separate from additional people and keyword nodes. Longer matches and ambiguity exclusions can remove earlier links.", "Form frequencies and passage examples are bounded to ten forms and five examples per selected target; aggregate counts use the complete corpus."],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "web/data")
    parser.add_argument("--output", type=Path, default=ROOT / ".artifacts/link-audit.json")
    args = parser.parse_args()
    report = audit(args.baseline, args.data_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Audited {report['coverage']['articles']:,} articles, {report['coverage']['paragraphs']:,} paragraphs and {report['coverage']['validatedLinks']:,} stored links.")
    print(f"Report: {args.output}")
