import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from text_processing import MentionMatcher, clean_text, resolve_entry


class MentionTests(unittest.TestCase):
    def setUp(self):
        self.matcher = MentionMatcher(
            {"nietzsche": "Friedrich Nietzsche", "ethics": "Ethics", "virtue": "Virtue Ethics", "kant": "Immanuel Kant", "truth": "Truth", "kant-morality": "Kant’s Moral Philosophy"},
            {"nietzsche": ["Nietzsche"], "kant": ["Kant"]},
        )

    def test_names_case_boundaries_and_possessives(self):
        text = "Nietzsche, NIETZSCHE and Nietzsche’s ideas, but not Nietzschean."
        links, counts = self.matcher.annotate(text, "other")
        self.assertEqual(counts, {"nietzsche": 3})
        self.assertEqual([text[start:end] for start, end, _ in links], ["Nietzsche", "NIETZSCHE", "Nietzsche"])

    def test_longest_matching_title_takes_precedence(self):
        links, counts = self.matcher.annotate("Virtue ethics concerns ethics. Kant's Moral Philosophy.", "other")
        self.assertEqual(counts, {"virtue": 1, "ethics": 1, "kant-morality": 1})
        self.assertEqual(len(links), 3)

    def test_self_mentions_are_excluded(self):
        links, counts = self.matcher.annotate("Friedrich Nietzsche discusses Nietzsche and truth.", "nietzsche")
        self.assertEqual(counts, {"truth": 1})
        self.assertEqual(len(links), 1)

    def test_utf16_offsets_work_after_non_bmp_characters(self):
        text = "𝒜: Nietzsche. 𝒝: truth."
        links, _ = self.matcher.annotate(text, "other")
        encoded = text.encode("utf-16-le")
        self.assertEqual([encoded[start * 2:end * 2].decode("utf-16-le") for start, end, _ in links], ["Nietzsche", "truth"])

    def test_ambiguous_aliases_are_not_linked(self):
        matcher = MentionMatcher({"one": "John Smith", "two": "Jane Smith"}, {"one": ["Smith"], "two": ["Smith"]})
        _, counts = matcher.annotate("Smith and John Smith", "other")
        self.assertEqual(counts, {"one": 1})
        self.assertIn("smith", matcher.ambiguous)

    def test_diacritics_hyphens_and_unicode_offsets_preserve_original_text(self):
        matcher = MentionMatcher({"lukacs": "György Lukács", "nagarjuna": "Nāgārjuna", "merleau": "Maurice Merleau-Ponty"}, {"lukacs": ["Lukács"], "merleau": ["Merleau-Ponty"]})
        text = "😀 Luka\u0301cs, Lukacs, Nāgārjuna and Merleau‑Ponty."
        links, counts = matcher.annotate(text, "other")
        self.assertEqual(counts, {"lukacs": 2, "nagarjuna": 1, "merleau": 1})
        encoded = text.encode("utf-16-le")
        self.assertEqual([encoded[start * 2:end * 2].decode("utf-16-le") for start, end, _ in links], ["Luka\u0301cs", "Lukacs", "Nāgārjuna", "Merleau‑Ponty"])

    def test_normalization_collisions_remain_ambiguous(self):
        matcher = MentionMatcher({"one": "One", "two": "Two"}, {"one": ["Lukács"], "two": ["Lukacs"]})
        self.assertIn("lukacs", matcher.ambiguous)
        self.assertEqual(matcher.annotate("Lukács and Lukacs", "other")[1], {})

    def test_competing_full_names_and_ambiguous_short_titles_are_not_mislinked(self):
        matcher = MentionMatcher({"murdoch": "Iris Murdoch", "david": "David", "lewis": "David Lewis"}, {"murdoch": ["Murdoch"], "david": ["David the Invincible"]}, {"blocked": {"david": ["David"]}, "excludedPhrases": ["John Murdoch"]})
        _, counts = matcher.annotate("John Murdoch, Iris Murdoch, Murdoch, David Wallace, David Lewis and David the Invincible.", "other")
        self.assertEqual(counts, {"murdoch": 2, "lewis": 1, "david": 1})

    def test_competing_bibliography_identity_blocks_only_the_ambiguous_short_name(self):
        matcher = MentionMatcher({"jung": "Carl Jung"}, {"jung": ["Jung"]}, {"contextual": {"jung": {"aliases": ["Jung"], "blockers": ["Jung, Elżbieta"]}}})
        blocked = matcher.blocked_aliases_for(["A discussion of Carl Jung and Jung.", "Jung, Elzbieta, 2022."])
        self.assertEqual(blocked, {"jung"})
        self.assertEqual(matcher.annotate("Carl Jung and Jung (2022).", "other", blocked)[1], {"jung": 1})
        self.assertEqual(matcher.annotate("Jung (1955).", "other", matcher.blocked_aliases_for(["Jung, Carl G., 1955."]))[1], {"jung": 1})

    def test_article_prefix_is_optional(self):
        matcher = MentionMatcher({"life": "The Meaning of Life"}, {})
        _, counts = matcher.annotate("The meaning of life, or meaning of life.", "other")
        self.assertEqual(counts, {"life": 2})

    def test_ambiguous_keyword_context_preserves_explicit_qualified_mentions(self):
        matcher = MentionMatcher({"depression": "Depression"}, {"depression": ["clinical depression"]}, {"contextual": {"depression": {"aliases": ["Depression"], "blockers": ["Great Depression"]}}})
        text = "The Great Depression preceded a discussion of depression and clinical depression."
        blocked = matcher.blocked_aliases_for([text])
        links, counts = matcher.annotate(text, "other", blocked)
        self.assertEqual(counts, {"depression": 1})
        self.assertEqual([text[start:end] for start, end, _ in links], ["clinical depression"])

    def test_text_entities_and_wrapped_paragraphs(self):
        self.assertEqual(clean_text("  Truth\n &amp;\n knowledge.  "), "Truth & knowledge.")

    def test_related_urls_preserve_case_and_reject_foreign_hosts(self):
        self.assertEqual(resolve_entry("../statphys-Boltzmann/", "time"), "statphys-Boltzmann")
        self.assertEqual(resolve_entry("https://plato.stanford.edu/entries/kant/#foo", "time"), "kant")
        self.assertIsNone(resolve_entry("https://example.com/entries/kant/", "time"))
        self.assertIsNone(resolve_entry("javascript:alert(1)", "time"))
        self.assertEqual(resolve_entry("file:///export/render.cgi%3fentry=ibn-sina&page=index.html", "time"), "ibn-sina")


if __name__ == "__main__":
    unittest.main()
