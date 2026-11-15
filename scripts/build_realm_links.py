"""Link the nodes that realms share, so each realm can open the same subject in another."""

import json
import re
from itertools import combinations

from realms import REALMS, built_realms, write_realm_index
from text_processing import key

# Reviewed false matches: the same words with a different meaning. Each entry names one node per realm.
EXCLUSIONS = REALMS / "link_exclusions.json"


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


def excluded_pairs(first_name, second_name):
    entries = json.loads(EXCLUSIONS.read_text())
    if not isinstance(entries, list) or not all(isinstance(entry, dict) and len(entry) == 2 and all(isinstance(value, str) for value in entry.values()) for entry in entries):
        raise ValueError("Invalid link exclusions")
    return {(entry[first_name], entry[second_name]) for entry in entries if set(entry) == {first_name, second_name}}


def build():
    realms = built_realms()
    graphs = {realm.name: json.loads((realm.output / "graph.json").read_text()) for realm in realms}
    links = {realm.name: {} for realm in realms}
    for first, second in combinations(realms, 2):
        omitted = excluded_pairs(first.name, second.name)
        forward = {node_id: other for node_id, other in shared_nodes(graphs[first.name], graphs[second.name]).items() if (node_id, other) not in omitted}
        links[first.name][second.name] = forward
        links[second.name][first.name] = dict(sorted((other, node_id) for node_id, other in forward.items()))
        print(f"Linked {len(forward):,} shared nodes between {first.name} and {second.name}.", flush=True)
    for realm in realms:
        (realm.output / "links.json").write_text(json.dumps(links[realm.name], ensure_ascii=False, separators=(",", ":")) + "\n")
    write_realm_index()


if __name__ == "__main__":
    build()
