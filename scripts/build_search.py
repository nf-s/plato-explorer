"""Build a static, sharded full-text index without a runtime database."""

import argparse
import json
import re
import time
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARDS = 128
TOKEN = re.compile(r"[^\W_]+", re.UNICODE)


def words(text):
    normalized = "".join(character for character in unicodedata.normalize("NFKD", text) if not unicodedata.category(character).startswith("M"))
    return TOKEN.findall(normalized.lower())


def shard_for(term):
    value = 2166136261
    for byte in term.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value % SHARDS


def read_article(path, expected_id):
    article = json.loads(path.read_text())
    if not isinstance(article, dict) or article.get("id") != expected_id or not isinstance(article.get("title"), str):
        raise ValueError(f"Invalid search article: {path.name}")
    for field in ("blocks", "bibliography"):
        blocks = article.get(field)
        if not isinstance(blocks, list) or any(not isinstance(block, dict) or not isinstance(block.get("text"), str) for block in blocks):
            raise ValueError(f"Invalid {field}: {path.name}")
    return article


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def build(data_dir):
    started = time.monotonic()
    graph = json.loads((data_dir / "graph.json").read_text())
    ids = [node["id"] for node in graph["nodes"] if node["article"]]
    if not ids or len(set(ids)) != len(ids) or any(not isinstance(article_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]+", article_id) for article_id in ids):
        raise ValueError("Invalid graph IDs")
    shards = [{} for _ in range(SHARDS)]
    lengths = []
    for index, article_id in enumerate(ids):
        article = read_article(data_dir / "articles" / f"{article_id}.json", article_id)
        counts = Counter(words(article["title"]))
        for block in article["blocks"] + article["bibliography"]:
            counts.update(words(block["text"]))
        lengths.append(sum(counts.values()))
        for term, frequency in counts.items():
            postings = shards[shard_for(term)].setdefault(term, [])
            postings.extend((index, frequency))
    output = data_dir / "search"
    output.mkdir(parents=True, exist_ok=True)
    for index, terms in enumerate(shards):
        write_json(output / f"{index:03}.json", {"version": 1, "shard": index, "terms": dict(sorted(terms.items()))})
    manifest = {"version": 1, "shards": SHARDS, "ids": ids, "lengths": lengths, "averageLength": sum(lengths) / len(lengths)}
    write_json(output / "manifest.json", manifest)
    files = list(output.glob("*.json"))
    size = sum(path.stat().st_size for path in files)
    largest = max(path.stat().st_size for path in files)
    print(f"Indexed {len(ids):,} articles, {sum(lengths):,} words, {sum(len(shard) for shard in shards):,} distinct terms in {time.monotonic() - started:.1f}s.", flush=True)
    print(f"Search assets: {size / 1024 / 1024:.1f} MiB; largest shard {largest / 1024:.0f} KiB.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "web/data")
    build(parser.parse_args().data_dir.resolve())
