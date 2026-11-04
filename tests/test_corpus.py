import json
import unittest
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "web/data"


@unittest.skipUnless((DATA / "graph.json").exists(), "Build the dataset to run corpus checks")
class CorpusTests(unittest.TestCase):
    def test_depression_excludes_reviewed_economic_and_physical_senses(self):
        for source in ["neoliberalism", "sidney-hook", "sounds"]:
            with self.subTest(source=source):
                article = json.loads((DATA / "articles" / (source + ".json")).read_text())
                targets = [target for block in article["blocks"] for _, _, target in block["links"]]
                self.assertNotIn("keyword-depression", targets)
        article = json.loads((DATA / "articles/althusser.json").read_text())
        targets = [target for block in article["blocks"] for _, _, target in block["links"]]
        self.assertIn("keyword-depression", targets)

    def test_british_aesthetics_links_the_requested_names(self):
        article = json.loads((DATA / "articles/aesthetics-18th-british.json").read_text())
        targets = {target for block in article["blocks"] for _, _, target in block["links"]}
        self.assertTrue({"shaftesbury", "burke", "person-joseph-addison"} <= targets)

    def test_competing_scholars_do_not_become_carl_jung_connections(self):
        for source in ["kilvington", "heytesbury", "games-abstraction", "information", "mead", "reconciliation"]:
            with self.subTest(source=source):
                article = json.loads((DATA / "articles" / (source + ".json")).read_text())
                targets = [target for block in article["blocks"] for _, _, target in block["links"]]
                self.assertNotIn("person-carl-jung", targets)
        article = json.loads((DATA / "articles/qt-consciousness.json").read_text())
        targets = [target for block in article["blocks"] for _, _, target in block["links"]]
        self.assertIn("person-carl-jung", targets)

    def test_article_links_exactly_support_every_directed_mention_count(self):
        graph = json.loads((DATA / "graph.json").read_text())
        expected = Counter()
        expected_related = set()
        ids = {node["id"] for node in graph["nodes"]}
        for source, target, forward, backward, related_forward, related_backward in graph["edges"]:
            first = graph["nodes"][source]["id"]
            second = graph["nodes"][target]["id"]
            if forward:
                expected[first, second] = forward
            if backward:
                expected[second, first] = backward
            if related_forward:
                expected_related.add((first, second))
            if related_backward:
                expected_related.add((second, first))
        actual = Counter()
        actual_related = set()
        for node in graph["nodes"]:
            if not node["article"]:
                self.assertFalse((DATA / "articles" / (node["id"] + ".json")).exists())
                continue
            article = json.loads((DATA / "articles" / (node["id"] + ".json")).read_text())
            self.assertEqual(article["id"], node["id"])
            self.assertTrue(article["blocks"], node["id"])
            for block in article["blocks"]:
                previous_end = 0
                encoded = block["text"].encode("utf-16-le")
                for start, end, target in block["links"]:
                    self.assertIn(target, ids)
                    self.assertNotEqual(target, node["id"])
                    self.assertGreaterEqual(start, previous_end)
                    self.assertLessEqual(end * 2, len(encoded))
                    self.assertTrue(encoded[start * 2:end * 2].decode("utf-16-le").strip())
                    actual[node["id"], target] += 1
                    previous_end = end
            for related in article["related"]:
                if related["id"] and related["id"] != node["id"]:
                    actual_related.add((node["id"], related["id"]))
        self.assertEqual(actual, expected)
        self.assertEqual(actual_related, expected_related)


if __name__ == "__main__":
    unittest.main()
