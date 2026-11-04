import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from audit_links import audit


class LinkAuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.data = self.root / "data"
        (self.data / "articles").mkdir(parents=True)
        self.baseline = self.root / "baseline.json"
        self.aliases = self.root / "aliases.json"
        self.write(self.aliases, {"meister-eckhart": ["Eckhart"]})
        nodes = [
            {"id": "source", "title": "Source", "article": True},
            {"id": "meister-eckhart", "title": "Meister Eckhart", "article": True},
            {"id": "concept", "title": "Concept", "article": True},
        ]
        self.write(self.baseline, self.graph(nodes, [[0, 2, 2, 0, 0, 0]]))
        nodes.append({"id": "person-carl-jung", "title": "Carl Jung", "article": False, "person": True, "kind": "person"})
        self.write(self.data / "graph.json", self.graph(nodes, [[0, 1, 2, 0, 0, 0], [0, 3, 1, 0, 0, 0]]))
        text = "😀 Eckhart and Eckhart cite Carl Jung."
        links = []
        offset = 0
        for term, target in [("Eckhart", "meister-eckhart"), ("Eckhart", "meister-eckhart"), ("Carl Jung", "person-carl-jung")]:
            start = text.index(term, offset)
            end = start + len(term)
            links.append([len(text[:start].encode("utf-16-le")) // 2, len(text[:end].encode("utf-16-le")) // 2, target])
            offset = end
        for node in nodes[:3]:
            blocks = [{"kind": "p", "text": text, "links": links}] if node["id"] == "source" else []
            self.write(self.data / "articles" / f"{node['id']}.json", {"id": node["id"], "blocks": blocks, "bibliography": [], "related": []})

    def tearDown(self):
        self.directory.cleanup()

    def write(self, path, value):
        path.write_text(json.dumps(value))

    def graph(self, nodes, edges):
        prepared = [{**node, "aliases": [], "mentions": 0, "references": 0, "degree": 0} for node in nodes]
        for a, b, forward, backward, _, _ in edges:
            prepared[a]["mentions"] += backward
            prepared[b]["mentions"] += forward
            prepared[a]["references"] += bool(backward)
            prepared[b]["references"] += bool(forward)
            prepared[a]["degree"] += 1
            prepared[b]["degree"] += 1
        return {"nodes": prepared, "edges": edges}

    def test_comparison_separates_new_people_from_alias_replacements(self):
        report = audit(self.baseline, self.data, self.aliases)
        self.assertEqual(report["coverage"]["articles"], 3)
        self.assertEqual(report["coverage"]["validatedLinks"], 3)
        self.assertEqual(report["articleConnections"], {"before": 1, "after": 1, "added": 1, "removed": 1})
        self.assertEqual(report["articleMentions"]["addedMentions"], 2)
        self.assertEqual(report["articleMentions"]["removedMentions"], 2)
        self.assertEqual(report["additionalNodes"]["people"]["mentions"], 1)
        eckhart = next(node for node in report["changedNodes"] if node["id"] == "meister-eckhart")
        self.assertEqual(eckhart["addedAliases"], ["Eckhart"])
        self.assertEqual(eckhart["matchedForms"][0]["count"], 2)
        self.assertEqual(eckhart["currentExamples"][0]["text"], "Eckhart")

    def test_graph_count_mismatch_is_rejected_even_with_valid_spans(self):
        path = self.data / "articles/source.json"
        article = json.loads(path.read_text())
        article["blocks"][0]["links"].pop()
        self.write(path, article)
        with self.assertRaisesRegex(ValueError, "disagree with graph counts"):
            audit(self.baseline, self.data, self.aliases)

    def test_overlap_and_surrogate_splitting_are_rejected(self):
        path = self.data / "articles/source.json"
        article = json.loads(path.read_text())
        article["blocks"][0]["links"][0][:2] = [1, 10]
        self.write(path, article)
        with self.assertRaisesRegex(ValueError, "splits a Unicode character"):
            audit(self.baseline, self.data, self.aliases)
        article["blocks"][0]["links"][0][:2] = [3, 18]
        self.write(path, article)
        with self.assertRaisesRegex(ValueError, "Invalid link span"):
            audit(self.baseline, self.data, self.aliases)


if __name__ == "__main__":
    unittest.main()
