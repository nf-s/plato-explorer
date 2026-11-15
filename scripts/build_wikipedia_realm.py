"""Turn the Wikipedia snapshot into source rows for one realm: nominate, copy, select and convert its articles."""

import argparse
import json

import wikipedia_rows
import wikipedia_scope
from wikipedia_extract import extract
from wikipedia_select import expand, select


def build(realm):
    snapshot = wikipedia_scope.SNAPSHOT
    work = wikipedia_scope.work_directory(realm)
    thresholds = wikipedia_scope.load_scope(realm)["selection"]
    index = snapshot / "index.parquet"
    if not index.is_file():
        raise SystemExit("Index the snapshot first: python scripts/wikipedia_extract.py index")
    wikipedia_scope.build(realm)
    extract(snapshot, index, json.loads((work / "candidates.json").read_text()), work / "candidates.jsonl")
    expand(work / "candidates.json", work / "candidates.jsonl", snapshot, thresholds["expandLinks"], work / "neighbours.json")
    extract(snapshot, index, json.loads((work / "neighbours.json").read_text()), work / "neighbours.jsonl")
    select(work / "candidates.json", [work / "candidates.jsonl", work / "neighbours.jsonl"], snapshot, thresholds["incoming"], thresholds["seedLinks"], thresholds["neighbourLinks"], thresholds["share"], work / "selected.json")
    wikipedia_rows.build(realm)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--realm", required=True)
    build(parser.parse_args().realm)
