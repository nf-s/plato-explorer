"""Convert selected Wikipedia articles to builder rows, with matching terms taken from link evidence."""

import argparse
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path


from text_processing import clean_text, key, regex_trie
from wikipedia_scope import SNAPSHOT, load_scope, work_directory
from wikipedia_select import REFERENCE_SECTIONS, LinkResolver, link_title, read_articles

ROOT = Path(__file__).resolve().parents[1]
# Lists of an author's works stay readable in the article but are not searched for mentions.
WORK_SECTIONS = {"further reading", "bibliography", "publications", "selected publications", "selected works", "selected bibliography", "books", "works", "works cited"}
OMITTED_SECTIONS = REFERENCE_SECTIONS - WORK_SECTIONS
PERSON_INFOBOXES = {"infobox scientist", "infobox person", "infobox academic", "infobox philosopher", "infobox writer", "infobox medical person", "infobox officeholder", "infobox artist", "infobox military person", "infobox criminal", "infobox religious biography", "infobox christian leader", "infobox royalty", "infobox economist", "infobox sportsperson", "infobox saint", "infobox theologian", "infobox clergy", "infobox jewish leader", "infobox rabbi", "infobox muslim leader", "infobox hindu leader", "infobox buddhist biography", "infobox monarch", "infobox noble", "infobox historian", "infobox politician"}
# Gods and fictional characters are given biographies as well.
FIGURE_INFOBOXES = ("infobox deity", "infobox character", "infobox mythical creature")
LIFESPAN = re.compile(r"\((?:(born|died) )?c?\.? ?(\d{3,4})(?:\s*[–-]\s*(\d{2,4}))?\)\s*$")
# Wars, plans and programmes have date ranges too, but shorter than a working life.
LIFESPAN_YEARS = range(15, 111)
# An occupation counts when it is the noun of the description, not when it describes one: "activist measures".
OCCUPATION = re.compile(r"\b(?:psychologist|psychiatrist|psychoanalyst|psychotherapist|neuroscientist|philosopher|physician|neurologist|sociologist|professor|researcher|scientist|author|writer|educator|therapist|economist|anthropologist|physiologist|linguist|statistician|biologist|theologian|criminologist|sexologist|historian|folklorist|mythographer|classicist|ethnologist|ethnographer|archaeologist|banker|businessman|businesswoman|entrepreneur|investor|politician|journalist|activist|poet|priest|bishop|archbishop|cardinal|pope|rabbi|imam|monk|nun|missionary|mystic|preacher|pastor|scholar|academic|painter|sculptor|photographer|printmaker|engraver|illustrator|artist|architect|designer|draughtsman|cartoonist|ceramicist|curator)\b(?=\s*(?:$|[,;(/]|(?:and|who|of|at|in|from|for|known)\b))")
NOT_A_PERSON = re.compile(r"^(?:book|film|novel|journal|organi[sz]ation|term|list|type|concept|award|theory|study|field|branch|practice|profession|occupation|professional|person who)\b| by ")
# Journals, societies and events have founding dates and academic descriptions too.
NOT_PERSON_NOUNS = re.compile(r"\b(?:journal|magazine|newspaper|periodical|degree|society|association|organi[sz]ation|institute|movement|discipline|recession|downturn|crisis|conference|treaty|dynasty|commune|forum|program|programme|plan|period|series|center|centre|agenda|company|division|bloc|agreement|group|body)\b")
OTHER_SUBJECT = "Other / interdisciplinary"


def slug(title):
    folded = "".join(char for char in unicodedata.normalize("NFKD", title) if not unicodedata.category(char).startswith("M"))
    return re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")


def article_ids(articles):
    """Readable, unique node IDs; the Wikidata ID settles collisions and reserved prefixes."""
    counts = Counter(slug(article["name"]) for article in articles)
    ids = {}
    for article in articles:
        base = slug(article["name"])
        if not base or counts[base] > 1 or base.startswith(("keyword-", "person-")):
            base = "-".join(part for part in (base, str(article["qid"] or article["pageId"]).lower()) if part)
        ids[article["name"]] = base
    if len(set(ids.values())) != len(ids):
        raise ValueError("Article IDs are not unique")
    return ids


def section_name(part):
    return clean_text(str(part.get("name") or ""))


def own_text(parts):
    """Paragraphs and list items directly under a section, excluding its subsections."""
    texts = []
    for part in parts:
        if not isinstance(part, dict) or part.get("type") == "section":
            continue
        value = part.get("value")
        if isinstance(value, str) and clean_text(value):
            texts.append(("• " if part.get("type") == "list_item" else "") + clean_text(value))
        texts.extend(own_text(part.get("has_parts") or []))
    return texts


def all_text(parts):
    texts = own_text(parts)
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "section":
            texts.extend(all_text(part.get("has_parts") or []))
    return texts


def links_in(parts):
    for part in parts:
        if not isinstance(part, dict):
            continue
        for link in part.get("links") or []:
            if isinstance(link, dict) and isinstance(link.get("text"), str):
                yield link
        yield from links_in(part.get("has_parts") or [])


def convert(article):
    """Split an article into introduction, sections, works lists and See also links."""
    preamble, main_text, bibliography, related, body_links = [], [], [], [], []

    def subsections(parts, depth, section):
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "section":
                continue
            name = section_name(part)
            children = part.get("has_parts") or []
            if name.lower() in WORK_SECTIONS:
                bibliography.extend(all_text(children))
            elif name.lower() not in OMITTED_SECTIONS and name.lower() != "see also":
                section["subsections"].append({"subsection_title": name, "content": own_text(children), "level": 3 if depth == 1 else 4})
                body_links.extend(links_in([child for child in children if isinstance(child, dict) and child.get("type") != "section"]))
                subsections(children, depth + 1, section)

    for part in article["sections"]:
        if not isinstance(part, dict):
            continue
        children = part.get("has_parts") or []
        name = section_name(part)
        if part.get("type") != "section" or name == "Abstract":
            preamble.extend(own_text(children if part.get("type") == "section" else [part]))
            body_links.extend(links_in(children if part.get("type") == "section" else [part]))
        elif name.lower() == "see also":
            related.extend(links_in(children))
        elif name.lower() in WORK_SECTIONS:
            bibliography.extend(all_text(children))
        elif name.lower() not in OMITTED_SECTIONS:
            section = {"section_title": name, "main_content": own_text(children), "subsections": []}
            body_links.extend(links_in([child for child in children if isinstance(child, dict) and child.get("type") != "section"]))
            subsections(children, 1, section)
            found = section["subsections"]
            # A heading without text stays only when it introduces deeper headings.
            section["subsections"] = [sub for index, sub in enumerate(found) if sub["content"] or (index + 1 < len(found) and found[index + 1]["level"] > sub["level"])]
            if section["main_content"] or section["subsections"]:
                main_text.append(section)
    return {"preamble": preamble, "main_text": main_text, "bibliography": bibliography, "related": related, "links": body_links}


def has_lifespan(description):
    """Whether a description ends with a birth year, a death year or the years of a life."""
    match = LIFESPAN.search(description)
    if not match:
        return False
    if match[1]:
        return True
    if not match[3]:
        return False
    start, end = match[2], match[3]
    # "(1945–53)" abbreviates the second year.
    end = start[: len(start) - len(end)] + end if len(end) < len(start) else end
    return int(end) - int(start) in LIFESPAN_YEARS


def is_person(article, occupation_listed):
    description = (article.get("description") or "").strip()
    if occupation_listed:
        return True
    if NOT_A_PERSON.search(description.lower()):
        return False
    infoboxes = [name.lower() for name in article.get("infoboxes") or [] if isinstance(name, str)]
    if any(name.startswith(FIGURE_INFOBOXES) for name in infoboxes):
        return False
    if any(name in PERSON_INFOBOXES for name in infoboxes):
        return True
    if NOT_PERSON_NOUNS.search(description.lower()):
        return False
    return has_lifespan(description) or (len(description.split()) <= 7 and bool(OCCUPATION.search(description.lower())))


def subject_patterns(scope):
    """Compile each subject's terms and list the subject each Wikidata seed points to."""
    patterns = {name: re.compile(r"\b(?:" + entry["terms"] + r")\b", re.I) for name, entry in scope["subjects"].items()}
    seeds = {seed: name for name, entry in scope["subjects"].items() for seed in entry["seeds"]}
    return patterns, seeds


def subject(article, seeds, introduction, patterns, seed_subjects):
    scores = {name: 6 * len(pattern.findall(article["name"])) + 3 * len(pattern.findall(article.get("description") or "")) + len(pattern.findall(introduction[:1600])) for name, pattern in patterns.items()}
    for seed in seeds:
        if seed in seed_subjects:
            scores[seed_subjects[seed]] += 4
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else OTHER_SUBJECT


def base_title(title):
    return re.sub(r"\s*\([^()]*\)$", "", title).strip()


def matching_terms(documents, title_share, alias_share, alias_lift, surname_share):
    """Decide which phrases identify each article.

    A phrase counts for an article when the articles using the phrase usually also link to
    it. This keeps "Freud" and "CBT" and rejects ordinary words such as a film called "Split".
    An alias must also beat the article's ordinary link rate, because half the corpus links
    to Psychology whether or not it says "psychological".
    Returns ({id: [alias]}, {id: [blocked title]}, report rows)."""
    link_sources = {}
    anchor_sources = {}
    display = {}
    for document in documents:
        for text, target in document["anchors"]:
            link_sources.setdefault(target, set()).add(document["id"])
            if target != document["id"] and len(key(text)) >= 3:
                anchor_sources.setdefault(key(text), {}).setdefault(target, set()).add(document["id"])
                display.setdefault(key(text), clean_text(text))
    candidates = {}
    title_owner = {}
    short_owner = {}
    surnames = {}
    for document in documents:
        title = key(document["title"])
        title_owner[title] = document["id"]
        candidates.setdefault(title, set()).add(document["id"])
        display[title] = document["title"]
        # The graph builder also matches a title without its leading "The", so "The Man" would claim every "man".
        short = document["title"][4:] if document["title"].lower().startswith("the ") else ""
        if len(key(short)) >= 3:
            short_owner.setdefault(key(short), document["id"])
            candidates.setdefault(key(short), set()).add(document["id"])
            display.setdefault(key(short), short)
        base = base_title(document["title"])
        if base != document["title"] and len(key(base)) >= 3:
            candidates.setdefault(key(base), set()).add(document["id"])
            display.setdefault(key(base), base)
        words = base.split()
        if document["person"] and words and len(key(words[-1])) >= 4 and words[-1][0].isupper() and not re.fullmatch(r"[IVX]+|Jr\.?|Sr\.?", words[-1]):
            surnames[document["id"]] = key(words[-1])
            candidates.setdefault(key(words[-1]), set()).add(document["id"])
            display.setdefault(key(words[-1]), words[-1])
    # An article whose whole title is the shorter phrase keeps it.
    for phrase, owner in short_owner.items():
        title_owner.setdefault(phrase, owner)
    for phrase, targets in anchor_sources.items():
        for target, sources in targets.items():
            if len(sources) >= 2:
                candidates.setdefault(phrase, set()).add(target)
    pattern = regex_trie(candidates)
    users = {}
    for document in documents:
        found = set()
        for paragraph in document["paragraphs"]:
            found.update(match.group() for match in pattern.finditer(key(paragraph)))
        for phrase in found:
            users.setdefault(phrase, set()).add(document["id"])
    aliases, blocked, report = {}, {}, []
    for phrase, targets in candidates.items():
        # The article named by the phrase owns it; otherwise the one it usually links to.
        owner = title_owner.get(phrase)
        if owner is None:
            linked = {target: len(anchor_sources.get(phrase, {}).get(target, ())) for target in targets}
            owner = max(sorted(targets), key=lambda target: linked[target])
            if len(targets) > 1 and linked[owner] < 0.6 * sum(linked.values()):
                continue
        others = users.get(phrase, set()) - {owner}
        linking = others & link_sources.get(owner, set())
        share = len(linking) / len(others) if others else 0.0
        usual = max(len(link_sources.get(owner, ())), 1) / len(documents)
        is_title = title_owner.get(phrase) == owner
        if is_title:
            accepted = share >= title_share or len(others) < 10
        else:
            # A single ordinary word needs twice the support of a longer phrase.
            single = " " not in phrase and "-" not in phrase and not display[phrase].isupper()
            needed = surname_share if surnames.get(owner) == phrase else alias_share * 2 if single else alias_share
            accepted = len(linking) >= 2 and share >= needed and share >= alias_lift * usual
        if accepted and not is_title:
            aliases.setdefault(owner, []).append(display[phrase])
        elif is_title and not accepted:
            # An unsupported title would link ordinary uses of the phrase to this article.
            blocked.setdefault(owner, []).append(display[phrase])
        report.append({"phrase": display[phrase], "target": owner, "share": round(share, 3), "lift": round(share / usual, 1), "linking": len(linking), "uses": len(others), "accepted": accepted, "title": is_title})
    # Where another article is titled with the shorter phrase, the phrase is that article's to
    # keep or lose. Left unblocked, "man" would fall to The Man once Man's own title is blocked.
    for phrase, owner in short_owner.items():
        if title_owner[phrase] != owner:
            blocked.setdefault(owner, []).append(display[phrase])
    return aliases, blocked, report


def write_rows(rows, output):
    """Write the rows with a fixed schema, so empty lists keep their types."""
    # Imported here so the text functions load without the Parquet library.
    import pyarrow as pa
    import pyarrow.parquet as pq

    strings = pa.list_(pa.string())
    schema = pa.schema([
        ("shorturl", pa.string()), ("title", pa.string()), ("pubinfo", pa.string()), ("url", pa.string()),
        ("person", pa.bool_()), ("subject", pa.string()), ("aliases", strings), ("blocked", strings),
        ("preamble", strings),
        ("toc", pa.list_(pa.struct([("content_title", pa.string()), ("sub_toc", strings)]))),
        ("main_text", pa.list_(pa.struct([
            ("section_title", pa.string()), ("main_content", strings),
            ("subsections", pa.list_(pa.struct([("subsection_title", pa.string()), ("content", strings), ("level", pa.int8())]))),
        ]))),
        ("bibliography", strings),
        ("related_entries", pa.list_(pa.struct([("href", pa.string()), ("text", pa.string())]))),
    ])
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), output)


def build(realm, snapshot=SNAPSHOT, title_share=0.05, alias_share=0.1, alias_lift=3.0, surname_share=0.5):
    work = work_directory(realm, snapshot)
    output = ROOT / "data" / realm / "articles.parquet"
    patterns, seed_subjects = subject_patterns(load_scope(realm))
    selected = json.loads((work / "selected.json").read_text())
    articles = {}
    for name in ("candidates.jsonl", "neighbours.jsonl"):
        for article in read_articles(work / name):
            if article["name"] in selected:
                articles[article["name"]] = article
    articles = [articles[name] for name in sorted(articles)]
    ids = article_ids(articles)
    resolver = LinkResolver(snapshot)
    converted = {article["name"]: convert(article) for article in articles}
    resolver.learn({title for parts in converted.values() for link in parts["links"] + parts["related"] if (title := link_title(link.get("url")))})

    def target(link):
        title = link_title(link.get("url"))
        return resolver.resolve(title) if title else None

    urls = {article["name"]: article["url"] for article in articles}
    documents, rows = [], []
    for article in articles:
        parts = converted[article["name"]]
        meta = selected[article["name"]]
        paragraphs = parts["preamble"] + [text for section in parts["main_text"] for text in section["main_content"] + [line for sub in section["subsections"] for line in sub["content"]]]
        if not paragraphs:
            continue
        person = is_person(article, meta["person"])
        documents.append({"id": ids[article["name"]], "title": article["name"], "person": person, "paragraphs": paragraphs, "anchors": [(link["text"], ids[name]) for link in parts["links"] if (name := target(link)) in ids]})
        related = []
        for link in parts["related"]:
            name = target(link)
            href = urls[name] if name in urls else link.get("url")
            if isinstance(href, str) and href.startswith("https://en.wikipedia.org/wiki/") and clean_text(link["text"]):
                related.append({"href": href, "text": clean_text(link["text"])})
        modified = (article.get("modified") or "")[:10]
        rows.append({
            "shorturl": ids[article["name"]], "title": article["name"], "url": article["url"],
            "pubinfo": f"English Wikipedia revision {article['revision']}" + (f", last modified {modified}." if modified else "."),
            "person": person, "subject": subject(article, meta["seeds"], " ".join(parts["preamble"]), patterns, seed_subjects),
            "preamble": parts["preamble"], "main_text": parts["main_text"], "bibliography": parts["bibliography"], "related_entries": related,
            "toc": [{"content_title": section["section_title"], "sub_toc": [sub["subsection_title"] for sub in section["subsections"]]} for section in parts["main_text"]],
        })
    aliases, blocked, report = matching_terms(documents, title_share, alias_share, alias_lift, surname_share)
    for row in rows:
        row["aliases"] = sorted(aliases.get(row["shorturl"], []))
        row["blocked"] = sorted(blocked.get(row["shorturl"], []))
    output.parent.mkdir(parents=True, exist_ok=True)
    write_rows(rows, output)
    report.sort(key=lambda entry: (-entry["uses"], entry["phrase"]))
    (output.parent / "matching-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {len(rows):,} articles ({sum(row['person'] for row in rows):,} people) to {output}", flush=True)
    print(f"Matching terms: {sum(len(row['aliases']) for row in rows):,} aliases accepted, {sum(len(row['blocked']) for row in rows):,} titles blocked", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--realm", required=True)
    parser.add_argument("--snapshot", type=Path, default=SNAPSHOT)
    parser.add_argument("--title-share", type=float, default=0.05, help="share of the articles using a common title that must link to it")
    parser.add_argument("--alias-share", type=float, default=0.1, help="the same share for another phrase to become an alias")
    parser.add_argument("--alias-lift", type=float, default=3.0, help="how far an alias must exceed the article's ordinary link rate")
    parser.add_argument("--surname-share", type=float, default=0.5, help="the share for a person's surname")
    args = parser.parse_args()
    build(args.realm, args.snapshot.resolve(), args.title_share, args.alias_share, args.alias_lift, args.surname_share)
