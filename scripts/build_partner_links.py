"""Link nodes that two explorers share, so each can open the other's page for the same subject."""

import argparse
import json
import re
from pathlib import Path

from sites import ROOT, SITES, load_site, site_names
from text_processing import key

ADDRESSES = SITES / "addresses.json"
# Reviewed false matches, as {site: [node ID]}: the same words with a different meaning.
EXCLUSIONS = SITES / "partner_exclusions.json"


def subject_terms(node):
    """A node's title, without a disambiguating suffix such as "(psychology)"."""
    title = node["title"]
    return {key(title), key(re.sub(r"\s*\([^()]*\)$", "", title))} - {""}


def unique_owners(graph, terms_of):
    owners = {}
    for node in graph["nodes"]:
        for term in terms_of(node):
            owners.setdefault(term, set()).add(node["id"])
    return {term: next(iter(ids)) for term, ids in owners.items() if len(ids) == 1}


def shared_nodes(first, second):
    """Return {first ID: second ID} for nodes whose titles match, or whose title matches an alias."""
    titles = unique_owners(first, subject_terms), unique_owners(second, subject_terms)
    aliases = unique_owners(first, lambda node: {key(alias) for alias in node["aliases"]}), unique_owners(second, lambda node: {key(alias) for alias in node["aliases"]})
    pairs = {}
    for term, node_id in titles[0].items():
        other = titles[1].get(term) or aliases[1].get(term)
        if other:
            pairs.setdefault(node_id, other)
    for term, other in titles[1].items():
        node_id = aliases[0].get(term)
        if node_id:
            pairs.setdefault(node_id, other)
    kinds = {node["id"]: node["person"] for node in first["nodes"]}, {node["id"]: node["person"] for node in second["nodes"]}
    # A person and a concept can share a name; only like kinds are the same subject.
    return {node_id: other for node_id, other in sorted(pairs.items()) if kinds[0][node_id] == kinds[1][other]}


def build(first_name, second_name, addresses):
    sites = load_site(first_name), load_site(second_name)
    graphs = [json.loads((site.output / "graph.json").read_text()) for site in sites]
    names = [json.loads(site.config.read_text())["name"] for site in sites]
    excluded = json.loads(EXCLUSIONS.read_text())
    omitted = set(excluded.get(first_name, [])), set(excluded.get(second_name, []))
    forward = {node_id: other for node_id, other in shared_nodes(graphs[0], graphs[1]).items() if node_id not in omitted[0] and other not in omitted[1]}
    backward = {other: node_id for node_id, other in forward.items()}
    for site, partner, name, ids in ((sites[0], sites[1], names[1], forward), (sites[1], sites[0], names[0], backward)):
        url = addresses.get(partner.name)
        if not isinstance(url, str) or not url.startswith("https://"):
            raise SystemExit(f"Add the public address of {partner.name} to {ADDRESSES.relative_to(ROOT)}.")
        (site.output / "partner.json").write_text(json.dumps({"name": name, "url": url, "ids": ids}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Linked {len(forward):,} shared nodes between {first_name} and {second_name}.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sites", nargs=2, choices=site_names())
    args = parser.parse_args()
    if not ADDRESSES.exists():
        raise SystemExit(f"Create {ADDRESSES.relative_to(ROOT)} with each site's public address; it is not kept in Git.")
    build(args.sites[0], args.sites[1], json.loads(ADDRESSES.read_text()))
