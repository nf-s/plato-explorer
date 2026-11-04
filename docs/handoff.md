# Plato Explorer handoff

Plato Explorer is a public, static browser for exploring **where SEP articles mention people and ideas**. A reader can follow a connection from the graph to the sentence that produced it, read the article in context, and return to the graph. The app also searches the complete text independently of the graph.

## Start a new thread

Read the [working instructions](../AGENTS.md), then use the relevant entry below. A fresh clone contains source and matching rules. To browse the corpus locally, follow the optional download and build steps in the README, then run `npm start` for a preview at `http://127.0.0.1:5173`.

| If the task concerns                                                                 | Start here                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Running the app or rebuilding the local corpus                                       | [README](../README.md)                                          |
| Adding a missing person, alias or keyword, or investigating an unexpected edge       | [Data model](data-model.md) and [link audit](link-audit.md)     |
| Finding words in article text or investigating request costs                         | [Full-text search](search.md)                                   |
| Taps, scrolling, history, passage highlights, mobile Contents or the Home Screen app | [Mobile navigation and acceptance checks](mobile-navigation.md) |
| Releasing the public site or maintaining its NFS home link                           | [Public deployment](public-deployment.md)                       |
| Maintaining the separate, earlier Google-protected Worker                            | [Private Worker reference](deployment.md)                       |

## Decisions to preserve

- **Source and identity.** The structured Parquet supplies the article text and editorial related entries. The December 2023 JSONL supplies author credits. The fetch script verifies both files against pinned checksums. The build records the primary file’s SHA-256 and graph counts in the local `web/data/build-report.json`. [Sources and provenance](data-model.md#source-selection)
- **What a connection means.** Each pair retains text mentions and explicit Related entries in each direction. Node size reflects incoming mentions. Line weight reflects mentions between the pair. The reader, graph and **Mentions** panel use the same stored matches. A mention of a person in a text is evidence of their name appearing there. Interpretations such as intellectual influence require reading the passage.
- **Specific ideas should remain discoverable.** Generic terms such as Time, Object and Truth dominated the first graph. The default hides mentions _to_ targets found in over half the articles. Minimum mentions starts at five, which also reduces drawing work. People, Topics and Keywords are independent checkboxes. Checking People and unchecking Topics while focused on Agency keeps Agency as the centre. A keyword-only overview can legitimately contain nodes with no edges.
- **People and words without pages matter.** Synthetic nodes such as Carl Jung and Music lead to the real articles that mention them. Use word and document frequencies to find candidates, then review their meanings and variants. An established topic, including one with a Wikipedia page, is a useful nomination. Ambiguous names and ordinary words require corpus checks. The [link audit](link-audit.md) explains how to measure both gains and false matches.
- **Visual and interaction preferences.** Use cool grey backgrounds, white panels, dark text, restrained slate accents and functional copy. The graph toolbar holds Network/List, the large shared search field and Filters. The user removed the logo and separate title bar to give the graph more room. Controls use a muted slate accent. Article links use a subtle colour and gain a faint underline on hover or focus. Computed communities help arrange the overview. “Colour by” offers estimated subject, node type, connection count and “No categories”. A hover badge identifies Article, Person or Keyword.
- **Following connections.** After selecting a node, Shift-click a neighbour or use its **Mentions** button. The latter is the touch and keyboard route. The original proposal to click individual edges proved impractical in dense graphs. Choosing a passage opens the source with the sentence and matching words highlighted. **Original on SEP** opens the publisher's entry. The mobile graph, Details, reader and section-jump history have specific restoration checks in the [mobile guide](mobile-navigation.md).
- **Access, cost and attribution.** The user chose a neutral public Pages address because the account's Workers hostname includes `nf-s` and changing the account namespace would affect other apps. Private Google OAuth with administrator grants was an earlier deployment and remains the general MA3-style pattern for new NFS apps. Production serves static graph, article and search files with zero D1 row reads. Retain the article credits, original links, copyright and independence notices. Crawler directives request exclusion and cannot guarantee that public material will never be scraped.

## Release record and verification

On 4 November 2026 the mobile **Contents** release passed 75 JavaScript and 27 Python tests. Live touch checks in WebKit covered 320px and 390px widths, section selection, exact scroll restoration, and rotation. These were browser-engine checks. Physical iPhone installation and interaction were not exercised by the automated runs.

For the next change, use `npm run check` and `npm test` with the generated data present. For changes to matching, save the previous graph first and run the corpus audit after rebuilding both data and search. For reader or navigation changes, exercise the actual taps and browser Back/Forward in a touch-enabled WebKit session. The targeted scenarios are in the guides above.

Source and documentation live in the [GitHub repository](https://github.com/nf-s/plato-explorer). Raw exports, generated files, audit output and credentials stay local. A push publishes source changes. Deployments require an explicit request and an agreed destination. Check redistribution rights before uploading material from the corpus. Pages receives an allowlisted build by direct upload. Keep hosted app addresses out of the public repository documentation. [Copyright and terms](../COPYRIGHT.md)
