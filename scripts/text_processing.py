"""Shared text normalization and longest-title-first mention detection."""

import html
import re
import unicodedata
from collections import Counter
from functools import lru_cache
from urllib.parse import unquote, urljoin, urlparse


def clean_text(text):
    if not isinstance(text, str):
        raise ValueError("Expected text, received " + type(text).__name__)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


@lru_cache(maxsize=4096)
def folded_character(char):
    if char in "’‘":
        return "'"
    if char in "‐‑‒–−":
        return "-"
    return "".join(part for part in unicodedata.normalize("NFKD", char).casefold() if not unicodedata.category(part).startswith("M"))


def key(text):
    return "".join(folded_character(char) for char in clean_text(text))


def matching_text(text):
    """Normalize spelling while retaining a map to original code-point spans."""
    if text.isascii():
        return text.lower(), None, None
    parts, starts, ends = [], [], []
    for index, char in enumerate(text):
        part = folded_character(char)
        if not part:
            # A decomposed accent belongs to the preceding original character.
            if ends:
                ends[-1] = index + 1
            continue
        parts.append(part)
        starts.extend([index] * len(part))
        ends.extend([index + 1] * len(part))
    return "".join(parts), starts, ends


def resolve_entry(href, source_id):
    """Accept only SEP article URLs; repair known export links without fetching them."""
    if not isinstance(href, str):
        raise ValueError("Related-entry href must be a string")
    url = urlparse(urljoin(f"https://plato.stanford.edu/entries/{source_id}/", href))
    if url.scheme in ("http", "https") and url.hostname == "plato.stanford.edu":
        match = re.search(r"/entries/([a-zA-Z0-9-]+)/", url.path)
        if match:
            return match.group(1)
    if url.scheme == "file":
        match = re.search(r"[?&]entry=([a-zA-Z0-9-]+)(?:&|$)", unquote(href))
        if match:
            return match.group(1)
    return None


def regex_trie(phrases):
    """Share title prefixes so matching the complete corpus stays inexpensive."""
    root = {}
    for phrase in phrases:
        node = root
        for char in phrase:
            node = node.setdefault(char, {})
        node[None] = {}

    def emit(node):
        choices = []
        for char, child in sorted(node.items(), key=lambda pair: pair[0] or "\uffff"):
            if char is None:
                choices.append("")
            else:
                token = "['’‘]" if char == "'" else re.escape(char)
                choices.append(token + emit(child))
        return choices[0] if len(choices) == 1 else "(?:" + "|".join(choices) + ")"

    return re.compile(r"(?<!\w)" + emit(root) + r"(?!\w)", re.IGNORECASE)


class MentionMatcher:
    def __init__(self, titles, aliases, rules=None):
        rules = rules or {}
        blocked = {article_id: {key(term) for term in terms} for article_id, terms in rules.get("blocked", {}).items()}
        candidates = {}
        for article_id, title in titles.items():
            candidates.setdefault(key(title), set()).add(article_id)
            if title.lower().startswith("the "):
                candidates.setdefault(key(title[4:]), set()).add(article_id)
        for article_id, variants in aliases.items():
            if article_id not in titles:
                continue
            for variant in variants:
                candidates.setdefault(key(variant), set()).add(article_id)
        for term, owners in candidates.items():
            owners.difference_update(article_id for article_id, terms in blocked.items() if term in terms)
        self.ambiguous = sorted(term for term, ids in candidates.items() if len(ids) > 1)
        self.targets = {term: next(iter(ids)) for term, ids in candidates.items() if len(ids) == 1 and len(term) >= 3}
        # Consume a known competing full name before a shorter surname can match.
        exclusions = {key(term) for term in rules.get("excludedPhrases", [])}
        phrases = set(self.targets) | exclusions
        self.pattern = regex_trie(phrases) if phrases else re.compile(r"(?!)")
        self.context_blockers = {}
        for entry in rules.get("contextual", {}).values():
            for blocker in entry["blockers"]:
                self.context_blockers.setdefault(key(blocker), set()).update(key(alias) for alias in entry["aliases"])
        self.context_pattern = regex_trie(self.context_blockers) if self.context_blockers else None

    def blocked_aliases_for(self, texts):
        """A known competing identity or sense makes its configured short term unsafe."""
        blocked = set()
        if self.context_pattern:
            for text in texts:
                for match in self.context_pattern.finditer(key(text)):
                    blocked.update(self.context_blockers.get(match.group(), set()))
        return blocked

    def annotate(self, text, source_id, blocked_aliases=None):
        links = []
        counts = Counter()
        utf16_offset = 0
        previous_end = 0
        normalized, starts, ends = matching_text(text)
        for match in self.pattern.finditer(normalized):
            if blocked_aliases and match.group() in blocked_aliases:
                continue
            target = self.targets.get(match.group())
            if target is None or target == source_id:
                continue
            start, end = match.span()
            if starts is not None and ends is not None:
                start, end = starts[start], ends[end - 1]
            utf16_offset += len(text[previous_end:start].encode("utf-16-le")) // 2
            length = len(text[start:end].encode("utf-16-le")) // 2
            links.append([utf16_offset, utf16_offset + length, target])
            utf16_offset += length
            previous_end = end
            counts[target] += 1
        return links, counts
