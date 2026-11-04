import { element, number } from "./data-model.js";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

// Use the same UTF-16 offsets as the reader and graph. Never rematch text here.
export function passages(article, target) {
  const matches = [];
  let section = "Introduction";
  article.blocks.forEach((block, blockIndex) => {
    if (block.kind.startsWith("h")) section = block.text;
    const links = block.links.filter((link) => link[2] === target);
    if (!links.length) return;
    const segments = [...sentences.segment(block.text)];
    const groups = new Map();
    for (const [start, end] of links) {
      const first = segments.find(
        (part) => part.index + part.segment.length > start,
      );
      const last = segments.find(
        (part) => part.index + part.segment.length >= end,
      );
      const from = first?.index ?? 0;
      const to = last ? last.index + last.segment.length : block.text.length;
      const key = `${from}:${to}`;
      if (!groups.has(key))
        groups.set(key, {
          section,
          blockIndex,
          start: from,
          end: to,
          text: block.text.slice(from, to),
          links: [],
        });
      groups.get(key).links.push([start - from, end - from]);
    }
    matches.push(...groups.values());
  });
  return matches;
}

export async function evidenceDirections(reader, source, target, signal) {
  const directions = [
    [source, target],
    [target, source],
  ].filter(([node]) => node.article);
  return Promise.all(
    directions.map(async ([node, destination]) => ({
      node,
      destination,
      article: await reader.load(node, signal),
    })),
  );
}

export class ConnectionEvidence {
  constructor(reader) {
    this.reader = reader;
    this.controller = null;
  }

  cancel() {
    this.controller?.abort();
  }

  async open(container, source, target, back) {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const previous = element(
      "button",
      "text-button evidence-back",
      `← ${source.title}`,
    );
    previous.addEventListener("click", back);
    const title = element(
      "h2",
      "evidence-title",
      `${source.title} ↔ ${target.title}`,
    );
    const body = element("div", "evidence-body");
    body.append(element("p", "connection-note", "Loading passages…"));
    container.replaceChildren(previous, title, body);
    try {
      const directions = await evidenceDirections(
        this.reader,
        source,
        target,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      body.replaceChildren();
      for (const { article, destination, node } of directions) {
        const found = passages(article, destination.id);
        const count = found.reduce(
          (total, passage) => total + passage.links.length,
          0,
        );
        const section = element("section", "evidence-direction");
        section.append(
          element(
            "h3",
            "section-title",
            `${node.title} → ${destination.title}`,
          ),
        );
        section.append(
          element(
            "p",
            "connection-note",
            `${number(count)} text mentions · ${number(found.length)} passages`,
          ),
        );
        if (article.related.some((entry) => entry.id === destination.id))
          section.append(
            element("p", "evidence-related", "Listed in Related entries"),
          );
        if (!found.length)
          section.append(
            element(
              "p",
              "connection-note",
              "No text mentions in this direction.",
            ),
          );
        for (const passage of found) {
          const card = element("div", "evidence-passage");
          const quote = element("blockquote");
          let position = 0;
          for (const [start, end] of passage.links) {
            quote.append(
              document.createTextNode(passage.text.slice(position, start)),
              element("mark", "", passage.text.slice(start, end)),
            );
            position = end;
          }
          quote.append(document.createTextNode(passage.text.slice(position)));
          const read = element("button", "text-button", `${passage.section} ↗`);
          read.title = `Read this passage in ${node.title}`;
          read.addEventListener("click", () =>
            this.reader.open(node, passage.blockIndex, {
              start: passage.start,
              end: passage.end,
              target: destination.id,
            }),
          );
          card.addEventListener("click", (event) => {
            if (!(event.target instanceof Element)) return;
            if (!event.target.closest("button")) read.click();
          });
          card.append(quote, read);
          section.append(card);
        }
        body.append(section);
      }
      body.append(
        element(
          "p",
          "connection-note",
          "All detected mentions are shown here, including any hidden by graph filters. A text match does not imply agreement or influence.",
        ),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const retry = element("button", "secondary-button", "Try again");
      retry.addEventListener("click", () =>
        this.open(container, source, target, back),
      );
      body.replaceChildren(
        element(
          "p",
          "connection-note",
          error instanceof Error
            ? error.message
            : "Passages could not be loaded.",
        ),
        retry,
      );
    }
  }
}
