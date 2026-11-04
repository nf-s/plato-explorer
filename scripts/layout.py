"""Deterministic community detection and an offline force-directed layout."""

import math
from collections import Counter, defaultdict

import numpy as np

PALETTE = ["#7e9b74", "#b38671", "#829caf", "#a496b2", "#b6a365", "#6f9c98", "#b98d9b", "#8b9baf", "#a6ab7d", "#a0907a", "#88a6a3", "#9a9b8c"]


def communities_and_layout(nodes, edges):
    size = len(nodes)
    if not size:
        return []
    rng = np.random.default_rng(42)
    adjacency = [defaultdict(float) for _ in nodes]
    for source, target, forward, backward, related_forward, related_backward in edges:
        weight = math.log1p(forward + backward) + 2 * (related_forward + related_backward)
        adjacency[source][target] += weight
        adjacency[target][source] += weight
    degree = np.array([sum(neighbors.values()) for neighbors in adjacency])
    total = max(float(degree.sum()), 1.0)
    labels = np.arange(size)
    community_degree = degree.copy()
    for iteration in range(35):
        moves = 0
        for i in rng.permutation(size):
            old = int(labels[i])
            weights = defaultdict(float)
            for neighbor, weight in adjacency[i].items():
                weights[int(labels[neighbor])] += weight
            community_degree[old] -= degree[i]
            best = old
            best_score = weights[old] - 1.1 * degree[i] * community_degree[old] / total
            for candidate, weight in weights.items():
                score = weight - 1.1 * degree[i] * community_degree[candidate] / total
                if score > best_score + 1e-9:
                    best, best_score = candidate, score
            labels[i] = best
            community_degree[best] += degree[i]
            moves += best != old
        if not moves:
            break

    counts = Counter(int(label) for label in labels)
    major = [label for label, count in counts.most_common(11) if count >= 8]
    if not major:
        major = [counts.most_common(1)[0][0]]
    mapping = {label: i for i, label in enumerate(major)}
    groups = np.array([mapping.get(int(label), len(major)) for label in labels])
    group_count = int(groups.max()) + 1
    result = []
    for group in range(group_count):
        members = np.flatnonzero(groups == group)
        representatives = sorted(members, key=lambda i: (-sum(weight for neighbor, weight in adjacency[i].items() if groups[neighbor] == group), nodes[i]["title"]))
        label = " / ".join(nodes[i]["title"].removeprefix("The ") for i in representatives[:2])
        if group == len(major):
            label = "Other communities"
        result.append({"id": group, "label": label, "color": PALETTE[group % len(PALETTE)], "count": len(members)})

    # Each article keeps its own position. Community anchors separate dense regions;
    # edge attraction and pairwise repulsion arrange articles inside those regions.
    angles = np.arange(group_count) * (2 * np.pi / group_count) - np.pi / 2
    anchors = np.stack([np.cos(angles), np.sin(angles)], axis=1) * 560
    positions = anchors[groups] + rng.normal(0, 135, (size, 2))
    sources = np.array([edge[0] for edge in edges], dtype=int)
    targets = np.array([edge[1] for edge in edges], dtype=int)
    weights = np.array([math.log1p(sum(edge[2:4])) + 2 * sum(edge[4:]) for edge in edges])
    if len(weights):
        weights /= np.maximum(np.sqrt(degree[sources] * degree[targets]), 1)
    for iteration in range(160):
        forces = (anchors[groups] - positions) * 0.012
        for start in range(0, size, 160):
            delta = positions[start:start + 160, None, :] - positions[None, :, :]
            distance_squared = np.maximum(np.sum(delta * delta, axis=2), 25)
            forces[start:start + 160] += np.sum(delta * (250 / distance_squared)[:, :, None], axis=1)
        if len(edges):
            delta = positions[targets] - positions[sources]
            pull = delta * (weights * 1.5)[:, None]
            np.add.at(forces, sources, pull)
            np.add.at(forces, targets, -pull)
        norms = np.maximum(np.linalg.norm(forces, axis=1), 1)
        temperature = 13 * (1 - iteration / 160) + 0.5
        positions += forces * np.minimum(temperature / norms, 1)[:, None]
    positions -= positions.mean(axis=0)
    for i, node in enumerate(nodes):
        node.update(x=round(float(positions[i, 0]), 2), y=round(float(positions[i, 1]), 2), community=int(groups[i]))
    return result
