"""Transparent, approximate subject labels; not SEP's own classification."""

import json
import re
from pathlib import Path

SUBJECT_TERMS = {
    "Ethics & society": r"ethic\w*|moral\w*|politic\w*|justice|rights|law|legal|democra\w*|feminis\w*|race|racism|gender|sex\w*|homosexual\w*|social|society|econom\w*|freedom|liberty|war|peace|virtue|responsibility|well-being",
    "Mind & knowledge": r"mind|mental|conscious\w*|cognit\w*|psycholog\w*|percept\w*|epistem\w*|knowledge|belief|memory|emotion|imagination|rationality|skeptic\w*|testimony|introspection",
    "Logic & language": r"logic\w*|language|linguistic\w*|semantic\w*|syntax|meaning|reference|proposition\w*|truth|paradox\w*|reasoning|inference|argument\w*|vagueness|definition\w*",
    "Science & mathematics": r"scien\w*|mathematic\w*|physics|physical|quantum|biology|biological|evolution\w*|probability|statistic\w*|comput\w*|geometry|arithmetic|number\w*|set theory|relativity|medicine|experiment\w*",
    "Metaphysics": r"metaphysic\w*|ontolog\w*|existence|being|caus\w*|time|space|identity|object\w*|properties|universals|modality|possibility|necessity|determinism|free will|substance|realism|idealism",
    "Religion": r"religio\w*|god|gods|theolog\w*|theism|atheism|divine|faith|christian\w*|islam\w*|jewish|judaism|buddhis\w*|hindu\w*|mystic\w*|heaven|afterlife",
    "Arts & aesthetics": r"aesthetic\w*|art|arts|artistic|beauty|music\w*|literat\w*|poetry|poetic|fiction|film|dance|architecture|humor",
    "History & traditions": r"ancient|medieval|renaissance|enlightenment|chinese|japanese|indian|arabic|african|stoic\w*|confucian\w*|daoism|platonism|scholastic\w*|pragmatism|phenomenolog\w*|existential\w*",
}
PATTERNS = {name: re.compile(r"\b(?:" + terms + r")\b", re.I) for name, terms in SUBJECT_TERMS.items()}


def people_ids(known):
    values = json.loads(Path(__file__).with_name("people.json").read_text())
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError("People must be a list of article IDs")
    if len(set(values)) != len(values) or set(values) - set(known):
        raise ValueError("People contains duplicate or unknown article IDs")
    return set(values)


def subject(row):
    title = row["title"]
    introduction = " ".join(row["preamble"])[:1600]
    related = " ".join(entry["text"] for entry in row["related_entries"])
    scores = {name: 6 * len(pattern.findall(title)) + len(pattern.findall(introduction)) + 2 * len(pattern.findall(related)) for name, pattern in PATTERNS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else "Other / interdisciplinary"
