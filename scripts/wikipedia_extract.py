"""Index the structured Wikipedia snapshot and copy selected articles out of it."""

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "data/wikipedia"
ARTICLE_COLUMNS = ["name", "identifier", "url", "abstract", "description", "date_modified", "main_entity", "version", "infoboxes", "sections"]


def shards(directory):
    paths = sorted(directory.glob("enwiki_namespace_0_*.parquet"), key=lambda path: int(path.stem.rsplit("_", 1)[1]))
    if not paths:
        raise SystemExit(f"No snapshot shards in {directory}; see docs/psychology.md.")
    return paths


def index_shard(path):
    file = pq.ParquetFile(path)
    rows = []
    for group in range(file.metadata.num_row_groups):
        table = file.read_row_group(group, columns=["name", "main_entity", "date_modified"])
        for row, record in enumerate(table.to_pylist()):
            entity = record["main_entity"]
            qid = entity.get("identifier") if isinstance(entity, dict) else None
            if isinstance(record["name"], str):
                rows.append((record["name"], qid, record["date_modified"], path.name, group, row))
    return rows


def build_index(directory, output):
    latest = {}
    with ProcessPoolExecutor() as pool:
        for done, rows in enumerate(pool.map(index_shard, shards(directory)), 1):
            for name, qid, modified, shard, group, row in rows:
                known = latest.get(name)
                if known is None or (modified is not None and (known[1] is None or modified > known[1])):
                    latest[name] = (qid, modified, shard, group, row)
            print(f"  indexed {done} shards, {len(latest):,} titles", flush=True)
    names = sorted(latest)
    table = pa.table({
        "name": names,
        "qid": [latest[name][0] for name in names],
        "shard": [latest[name][2] for name in names],
        "group": [latest[name][3] for name in names],
        "row": [latest[name][4] for name in names],
    })
    pq.write_table(table, output)
    print(f"Indexed {len(names):,} titles in {output}", flush=True)


def extract_shard(job):
    path, groups = job
    file = pq.ParquetFile(path)
    records = []
    for group, rows in sorted(groups.items()):
        table = file.read_row_group(group, columns=ARTICLE_COLUMNS).take(sorted(rows))
        for record in table.to_pylist():
            entity = record["main_entity"]
            version = record["version"]
            infoboxes = json.loads(record["infoboxes"]) if record["infoboxes"] else []
            records.append({
                "name": record["name"],
                "pageId": record["identifier"],
                "url": record["url"],
                "qid": entity.get("identifier") if isinstance(entity, dict) else None,
                "abstract": record["abstract"],
                "description": record["description"],
                "modified": record["date_modified"].isoformat() if record["date_modified"] else None,
                "revision": version.get("identifier") if isinstance(version, dict) else None,
                "infoboxes": [box.get("name") for box in infoboxes if isinstance(box, dict)],
                "sections": json.loads(record["sections"]) if record["sections"] else [],
            })
    return records


def extract(directory, index_path, titles, output):
    wanted = set(titles)
    index = pq.read_table(index_path).to_pylist()
    jobs = {}
    for entry in index:
        if entry["name"] in wanted:
            jobs.setdefault(entry["shard"], {}).setdefault(entry["group"], []).append(entry["row"])
    found = 0
    output.parent.mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor() as pool, output.open("w") as stream:
        for records in pool.map(extract_shard, [(directory / shard, groups) for shard, groups in sorted(jobs.items())]):
            for record in records:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                found += 1
    print(f"Copied {found:,} of {len(wanted):,} requested articles to {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=SNAPSHOT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("index")
    copy = commands.add_parser("extract")
    copy.add_argument("--titles", type=Path, required=True, help="JSON list or object keyed by article title")
    copy.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    snapshot = args.snapshot.resolve()
    if args.command == "index":
        build_index(snapshot, snapshot / "index.parquet")
    else:
        extract(snapshot, snapshot / "index.parquet", json.loads(args.titles.read_text()), args.output.resolve())
