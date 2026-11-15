import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from build_realm_links import same_articles, shared_nodes
from wikipedia_rows import article_ids, convert, is_person, matching_terms, subject, subject_patterns
from wikipedia_scope import load_scope
from wikipedia_select import link_title, outgoing_titles


def paragraph(value, links=()):
    return {"type": "paragraph", "value": value, "links": [{"url": f"https://en.wikipedia.org/wiki/{target}", "text": text} for text, target in links]}


def section(name, *parts):
    return {"type": "section", "name": name, "has_parts": list(parts)}


class LinkTests(unittest.TestCase):
    def test_link_titles_drop_fragments_other_namespaces_and_other_sites(self):
        self.assertEqual(link_title("https://en.wikipedia.org/wiki/Stress_(biology)#Types"), "Stress (biology)")
        self.assertEqual(link_title("https://en.wikipedia.org/wiki/cognitive_bias"), "Cognitive bias")
        self.assertIsNone(link_title("https://en.wikipedia.org/wiki/File:Brain.png"))
        self.assertIsNone(link_title("https://example.org/wiki/Memory"))
        self.assertIsNone(link_title(None))

    def test_reference_sections_do_not_count_as_article_links(self):
        article = {"name": "Memory", "sections": [
            section("Abstract", paragraph("Memory and attention.", [("attention", "Attention"), ("Memory", "Memory")])),
            section("References", paragraph("A book.", [("Publisher", "Oxford_University_Press")])),
        ]}
        self.assertEqual(outgoing_titles(article), {"Attention"})


class ConversionTests(unittest.TestCase):
    def test_sections_become_introduction_body_works_and_related_links(self):
        article = {"sections": [
            section("Abstract", paragraph("Introduction.")),
            section("History", paragraph("Early work."), {"type": "list", "has_parts": [{"type": "list_item", "value": "First item"}]},
                    section("Origins", paragraph("Detail."), section("Later", paragraph("Deeper."))),
                    section("Notes", paragraph("Omitted."))),
            section("Selected works", {"type": "list", "has_parts": [{"type": "list_item", "value": "A Book (1950)"}]}),
            section("See also", {"type": "list", "has_parts": [{"type": "list_item", "value": "Attention", "links": [{"url": "https://en.wikipedia.org/wiki/Attention", "text": "Attention"}]}]}),
            section("References", paragraph("Omitted.")),
            section("Empty"),
        ]}
        parts = convert(article)
        self.assertEqual(parts["preamble"], ["Introduction."])
        self.assertEqual(len(parts["main_text"]), 1)
        history = parts["main_text"][0]
        self.assertEqual(history["main_content"], ["Early work.", "• First item"])
        self.assertEqual([(sub["subsection_title"], sub["level"], sub["content"]) for sub in history["subsections"]], [("Origins", 3, ["Detail."]), ("Later", 4, ["Deeper."])])
        self.assertEqual(parts["bibliography"], ["• A Book (1950)"])
        self.assertEqual([link["text"] for link in parts["related"]], ["Attention"])

    def test_ids_are_readable_unique_and_avoid_reserved_prefixes(self):
        ids = article_ids([
            {"name": "Stress (biology)", "qid": "Q1", "pageId": 1},
            {"name": "Stress, biology", "qid": "Q2", "pageId": 2},
            {"name": "Person-centered therapy", "qid": "Q3", "pageId": 3},
            {"name": "Émile Durkheim", "qid": "Q4", "pageId": 4},
        ])
        self.assertEqual(ids["Stress (biology)"], "stress-biology-q1")
        self.assertEqual(ids["Stress, biology"], "stress-biology-q2")
        self.assertEqual(ids["Person-centered therapy"], "person-centered-therapy-q3")
        self.assertEqual(ids["Émile Durkheim"], "emile-durkheim")

    def test_people_are_recognised_from_occupation_seeds_infoboxes_and_descriptions(self):
        self.assertTrue(is_person({"description": "", "infoboxes": []}, True))
        self.assertTrue(is_person({"description": "American railroad worker (1823–1860)", "infoboxes": []}, False))
        self.assertTrue(is_person({"description": "Swiss physician", "infoboxes": []}, False))
        self.assertTrue(is_person({"description": "", "infoboxes": ["Infobox scientist"]}, False))
        self.assertFalse(is_person({"description": "Book by American psychologist B. F. Skinner", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Mental disorder", "infoboxes": ["Infobox medical condition"]}, False))
        self.assertTrue(is_person({"description": "British academic", "infoboxes": []}, False))
        self.assertTrue(is_person({"description": "American academic and author", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Academic journal", "infoboxes": ["Infobox journal"]}, False))
        self.assertFalse(is_person({"description": "Postgraduate academic degree", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "German socialist journal (1883–1923)", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Global economic downturn (1918–1921)", "infoboxes": []}, False))
        self.assertTrue(is_person({"description": "President of a learned society", "infoboxes": ["Infobox officeholder"]}, False))
        self.assertTrue(is_person({"description": "Chinese general and folk hero (died 220)", "infoboxes": []}, False))
        self.assertTrue(is_person({"description": "Philosopher (born 1969)", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Massacre in Western Australia (1834)", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Popular revolt in Upstate New York (1839–1845)", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Domestic agenda of a U.S. president (1945–53)", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Investor pressure that enforces financial prudence", "infoboxes": []}, False))
        self.assertFalse(is_person({"description": "Fish avatar of Vishnu", "infoboxes": ["Infobox deity<!--Hindu mythology-->", "Infobox royalty"]}, False))

    def test_subject_uses_title_description_introduction_and_seed_classes(self):
        patterns, seeds = subject_patterns(load_scope("psychology"))
        self.assertEqual(subject({"name": "Working memory", "description": "Cognitive system"}, [], "Holds information for reasoning.", patterns, seeds), "Cognition & perception")
        self.assertEqual(subject({"name": "Koro", "description": ""}, ["mental disorder"], "", patterns, seeds), "Clinical & disorders")
        self.assertEqual(subject({"name": "Zeitgeist", "description": ""}, [], "", patterns, seeds), "Other / interdisciplinary")


class MatchingTermTests(unittest.TestCase):
    def setUp(self):
        def document(article_id, title, paragraphs, anchors=(), person=False):
            return {"id": article_id, "title": title, "person": person, "paragraphs": paragraphs, "anchors": list(anchors)}

        self.documents = [
            document("freud", "Sigmund Freud", ["Founder of psychoanalysis."], person=True),
            document("cbt", "Cognitive behavioral therapy", ["A talking therapy."]),
            document("split", "Split", ["A film."]),
            document("projection", "Psychological projection", ["A defence."]),
            document("a", "Article A", ["Freud wrote on dreams. CBT helps. The group split in two. Freud described projection."], [("Sigmund Freud", "freud"), ("CBT", "cbt"), ("projection", "projection")]),
            document("b", "Article B", ["Freud and CBT differ. Opinions split. A projection of blame."], [("Freud", "freud"), ("CBT", "cbt"), ("projection", "projection")]),
            document("c", "Article C", ["Freud again; CBT again. They split up."], [("Freud", "freud"), ("cognitive behavioural therapy", "cbt")]),
        ]
        self.documents.extend(document(f"filler-{number}", f"Filler {number}", ["The vote was split. A map projection."]) for number in range(30))

    def test_linked_names_and_abbreviations_become_aliases(self):
        aliases, blocked, _ = matching_terms(self.documents, 0.05, 0.1, 3.0, 0.5)
        self.assertIn("Freud", aliases["freud"])
        self.assertIn("CBT", aliases["cbt"])
        self.assertNotIn("freud", blocked)

    def test_ordinary_words_do_not_become_links(self):
        aliases, blocked, report = matching_terms(self.documents, 0.05, 0.1, 3.0, 0.5)
        self.assertEqual(blocked["split"], ["Split"])
        self.assertNotIn("projection", [alias.lower() for alias in aliases.get("projection", [])])
        entry = next(row for row in report if row["phrase"] == "Split")
        self.assertFalse(entry["accepted"])
        self.assertEqual(entry["uses"], 33)


class ScopeTests(unittest.TestCase):
    def test_every_wikipedia_realm_estimates_the_subjects_its_interface_lists(self):
        realms = Path(__file__).resolve().parents[1] / "realms"
        names = [path.parent.name for path in sorted(realms.glob("*/scope.json"))]
        self.assertIn("mythology", names)
        for name in names:
            patterns, _ = subject_patterns(load_scope(name))
            listed = [entry[0] for entry in json.loads((realms / name / "realm.json").read_text())["subjects"]]
            self.assertEqual([*patterns, "Other / interdisciplinary"], listed)


class PartnerLinkTests(unittest.TestCase):
    def test_titles_and_aliases_match_but_people_never_match_concepts(self):
        def node(node_id, title, aliases=(), person=False):
            return {"id": node_id, "title": title, "aliases": list(aliases), "person": person}

        philosophy = {"nodes": [node("love", "Love"), node("freud", "Sigmund Freud", ["Freud"], True), node("keyword-music", "Music"), node("mill", "John Stuart Mill", ["Mill"], True), node("memory", "Memory")]}
        psychology = {"nodes": [node("love", "Love"), node("sigmund-freud", "Sigmund Freud", [], True), node("music-psychology", "Psychology of music", ["Music"]), node("mill", "Mill (grinding)"), node("memory", "Memory"), node("memory-2", "Memory (journal)")]}
        self.assertEqual(shared_nodes(philosophy, psychology), {"freud": "sigmund-freud", "keyword-music": "music-psychology", "love": "love"})

    def test_realms_from_one_source_share_only_the_same_article(self):
        def node(node_id, title, address=None):
            return {"id": node_id, "title": title, "aliases": [], "person": False, "url": address}

        wiki = "https://en.wikipedia.org/wiki/"
        economics = {"nodes": [node("demand", "Demand", wiki + "Demand"), node("stimulus-economics", "Stimulus (economics)", wiki + "Stimulus_(economics)"), node("keyword-thrift", "Thrift")]}
        psychology = {"nodes": [node("demand-psychoanalysis", "Demand (psychoanalysis)", wiki + "Demand_(psychoanalysis)"), node("stimulus-economics", "Stimulus (economics)", wiki + "Stimulus_(economics)"), node("keyword-thrift", "Thrift")]}
        self.assertEqual(same_articles(economics, psychology), {"stimulus-economics": "stimulus-economics"})


if __name__ == "__main__":
    unittest.main()
