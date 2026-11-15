"""Pack a realm's articles into shared files, so a release holds far fewer files than articles."""

import argparse
import json
import math
from pathlib import Path

from realms import load_realm, realm_names, write_realm_index
from text_processing import fnv1a

# A reader downloads the whole pack that holds an article, so packs stay small.
TARGET_BYTES = 256 * 1024
MAXIMUM_PACKS = 10_000


def pack_for(article_id, packs):
    return fnv1a(article_id) % packs


def pack(data_dir, target_bytes=TARGET_BYTES):
    """Write packs/NNNN.json and packs/manifest.json for the graph's articles; return the pack count."""
    graph = data_dir / "graph.json"
    if not graph.is_file():
        raise SystemExit(f"No graph under {data_dir}; build the realm first.")
    # The graph lists the current articles; files left by an earlier build are ignored.
    ids = [node["id"] for node in json.loads(graph.read_text())["nodes"] if node["article"]]
    texts = {article_id: (data_dir / "articles" / f"{article_id}.json").read_text() for article_id in ids}
    size = sum(len(text.encode("utf-8")) for text in texts.values())
    packs = min(len(texts), MAXIMUM_PACKS, max(1, math.ceil(size / target_bytes)))
    grouped = [{} for _ in range(packs)]
    for article_id, text in texts.items():
        grouped[pack_for(article_id, packs)][article_id] = json.loads(text)
    directory = data_dir / "packs"
    directory.mkdir(exist_ok=True)
    for stale in directory.glob("*.json"):
        stale.unlink()
    for index, articles in enumerate(grouped):
        (directory / f"{index:04}.json").write_text(json.dumps({"version": 1, "pack": index, "articles": articles}, ensure_ascii=False, separators=(",", ":")))
    (directory / "manifest.json").write_text(json.dumps({"version": 1, "packs": packs, "articles": len(texts)}) + "\n")
    return packs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--realm", default=realm_names()[0], choices=realm_names())
    chosen = load_realm(parser.parse_args().realm)
    print(f"Packed {chosen.name} into {pack(chosen.output):,} files.")
    write_realm_index()
