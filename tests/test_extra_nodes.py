import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from extra_nodes import INVENTORY, load_extra_nodes, validate_inventory
from text_processing import MentionMatcher


def record(article_id, title, kind="keyword", aliases=None):
    return {"id": article_id, "title": title, "kind": kind, "aliases": aliases or [], "subject": "Other / interdisciplinary"}


def row(article_id, text):
    return {"shorturl": article_id, "preamble": [text], "main_text": [{"section_title": "Ignored heading", "main_content": [], "subsections": []}], "bibliography": ["Ignored bibliography"]}


class ExtraNodeTests(unittest.TestCase):
    def load(self, inventory, rows, titles=None, aliases=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nodes.json"
            path.write_text(json.dumps(inventory, ensure_ascii=False))
            return load_extra_nodes(rows, titles or {}, aliases or {}, path)

    def test_core_nodes_and_frequency_count_all_words_without_mutating_sources(self):
        inventory = [record("keyword-music", "Music"), record("keyword-aestheticism", "Aestheticism"), record("person-carl-jung", "Carl Jung", "person", ["Jung"])]
        rows = [row("one", "Jung discusses music and aestheticism. Music matters."), row("two", "Carl Jung links aestheticism with music.")]
        before = copy.deepcopy(rows)
        nodes, audit = self.load(inventory, rows)
        self.assertEqual(rows, before)
        self.assertEqual(len(nodes), 3)
        self.assertTrue(all(node["article"] is False and node["url"] is None for node in nodes))
        self.assertTrue(next(node for node in nodes if node["kind"] == "person")["person"])
        words = {item["word"]: item for item in audit["wordFrequencies"]}
        self.assertEqual(words["music"], {"word": "music", "count": 3, "articles": 2})
        self.assertIn("discusses", words)
        self.assertNotIn("ignored", words)
        self.assertEqual(next(item for item in audit["accepted"] if item["id"] == "person-carl-jung")["mentions"], 2)

    def test_exact_real_aliases_prevent_duplicates_but_person_topic_titles_do_not(self):
        inventory = [record("keyword-music", "Music"), record("person-robert-nozick", "Robert Nozick", "person")]
        rows = [row("one", "Music and Robert Nozick."), row("two", "Music and Robert Nozick.")]
        nodes, audit = self.load(inventory, rows, {"music": "The Philosophy of Music", "nozick": "Robert Nozick’s Political Philosophy"}, {"music": ["Music"]})
        self.assertEqual([node["id"] for node in nodes], ["person-robert-nozick"])
        self.assertEqual(len(audit["rejected"]), 1)
        exact, _ = self.load(inventory, rows, {"person": "Robert Nozick", "music": "Music"})
        self.assertEqual(exact, [])

    def test_distinct_article_threshold_and_whole_word_matching(self):
        nodes, audit = self.load([record("keyword-music", "Music")], [row("one", "Music music music."), row("two", "Musical musicians.")])
        self.assertEqual(nodes, [])
        self.assertEqual(audit["rejected"][0]["mentions"], 3)
        self.assertEqual(audit["rejected"][0]["articles"], 1)

    def test_accent_normalization_preserves_examples_and_combining_mark_words(self):
        nodes, audit = self.load([record("person-edouard-glissant", "Édouard Glissant", "person")], [row("one", "Édouard Glissant wrote."), row("two", "E\u0301douard Glissant wrote.")])
        self.assertEqual(len(nodes), 1)
        words = {item["word"]: item["count"] for item in audit["wordFrequencies"]}
        self.assertEqual(words["edouard"], 2)
        self.assertNotIn("douard", words)
        self.assertIn("Édouard", audit["accepted"][0]["examples"][0]["text"])

    def test_inventory_rejects_duplicates_bad_kinds_and_unknown_fields(self):
        good = record("keyword-music", "Music")
        for bad in [[good, good], [{**good, "kind": "article"}], [{**good, "aliases": ["music"]}], [{**good, "subject": []}], [{**good, "url": "https://example.com"}]]:
            with self.assertRaises(ValueError):
                validate_inventory(bad)
        with self.assertRaises(ValueError):
            self.load([good], [], {"keyword-music": "Existing"})

    def test_curated_inventory_contains_requested_examples(self):
        inventory = validate_inventory(json.loads(INVENTORY.read_text()))
        ids = {item["id"] for item in inventory}
        self.assertTrue({"keyword-music", "keyword-aestheticism", "person-carl-jung"} <= ids)

    def test_requested_word_families_share_targets_without_merging_dao_and_daoism(self):
        wanted = {"keyword-dao", "keyword-veganism", "keyword-depression"}
        records = [item for item in json.loads(INVENTORY.read_text()) if item["id"] in wanted]
        self.assertEqual({item["id"] for item in records}, wanted)
        titles = {item["id"]: item["title"] for item in records}
        aliases = {item["id"]: item["aliases"] for item in records}
        titles["daoism"] = "Daoism"
        aliases["daoism"] = json.loads(INVENTORY.with_name("aliases.json").read_text())["daoism"]
        rules = json.loads(INVENTORY.with_name("mention_rules.json").read_text())
        matcher = MentionMatcher(titles, aliases, rules)
        text = "Dao, Tao; Daoism, Taoism, Daoist, Taoist, Daoists, Taoists; veganism, vegan, vegans; clinical depression."
        _, counts = matcher.annotate(text, "other", matcher.blocked_aliases_for([text]))
        self.assertEqual(counts, {"keyword-dao": 2, "daoism": 6, "keyword-veganism": 3, "keyword-depression": 1})
        text = "Shen Dao, Tao Hongjing, and the Great Depression."
        self.assertEqual(matcher.annotate(text, "other", matcher.blocked_aliases_for([text]))[1], {})


if __name__ == "__main__":
    unittest.main()
