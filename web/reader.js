import { element, validateArticle } from "./data-model.js";
import { ArticlePreview } from "./article-preview.js";

function validHighlight(block, highlight) {
  return (
    highlight !== null &&
    typeof highlight === "object" &&
    Number.isSafeInteger(highlight.start) &&
    Number.isSafeInteger(highlight.end) &&
    highlight.start >= 0 &&
    highlight.start < highlight.end &&
    highlight.end <= block.text.length &&
    typeof highlight.target === "string" &&
    block.links.some(
      ([start, end, target]) =>
        target === highlight.target &&
        start >= highlight.start &&
        end <= highlight.end,
    )
  );
}

// Keep each original link intact while marking text using its UTF-16 offsets.
export function readerParts(block, highlight = null) {
  const selected = validHighlight(block, highlight) ? highlight : null;
  const parts = [];
  function append(start, end, target = null) {
    if (start === end) return;
    const segments = [];
    const from = selected ? Math.max(start, selected.start) : end;
    const to = selected ? Math.min(end, selected.end) : start;
    if (from < to) {
      if (start < from)
        segments.push({ text: block.text.slice(start, from), highlight: null });
      segments.push({
        text: block.text.slice(from, to),
        highlight:
          target === selected.target
            ? "reader-mention-highlight"
            : "reader-passage-highlight",
      });
      if (to < end)
        segments.push({ text: block.text.slice(to, end), highlight: null });
    } else {
      segments.push({ text: block.text.slice(start, end), highlight: null });
    }
    parts.push({ target, segments });
  }
  let position = 0;
  for (const [start, end, target] of block.links) {
    append(position, start);
    append(start, end, target);
    position = end;
  }
  append(position, block.text.length);
  return parts;
}

export class ArticleReader {
  constructor(graph, onNavigate) {
    this.graph = graph;
    this.ids = new Set(graph.nodes.map((node) => node.id));
    this.dialog = document.getElementById("reader");
    this.content = document.getElementById("reader-content");
    this.toc = document.getElementById("reader-toc");
    this.contentsButton = document.getElementById("reader-contents-button");
    this.contentsDialog = document.getElementById("reader-contents-dialog");
    this.title = document.getElementById("reader-title");
    this.original = document.getElementById("reader-original");
    this.onNavigate = onNavigate;
    this.onOpen = null;
    this.onClose = null;
    this.onLocation = null;
    this.location = null;
    this.cache = new Map();
    this.controller = null;
    this.preview = new ArticlePreview(this);
    this.contentsButton.addEventListener("click", () => {
      this.preview.hide();
      this.contentsButton.focus({ preventScroll: true });
      this.contentsDialog.append(this.toc);
      this.contentsDialog.showModal();
      this.contentsButton.setAttribute("aria-expanded", "true");
    });
    document
      .getElementById("reader-contents-close")
      .addEventListener("click", () => this.closeContents());
    this.contentsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeContents();
    });
    this.contentsDialog.addEventListener("click", (event) => {
      if (event.target === this.contentsDialog) this.closeContents();
    });
    document
      .getElementById("reader-close")
      .addEventListener("click", () => this.close());
    this.dialog.addEventListener("close", () => {
      if (!this.dialog.open) {
        this.controller?.abort();
        this.preview.hide();
      }
    });
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.content.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[data-article]");
      if (
        !anchor ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const id = anchor.getAttribute("data-article");
      if (id && this.ids.has(id)) {
        event.preventDefault();
        this.onNavigate(id);
      }
    });
  }

  close() {
    if (this.onClose) return this.onClose();
    this.dismiss();
  }

  closeContents() {
    if (!this.contentsDialog.open) return;
    this.contentsDialog.close();
    this.dialog.querySelector(".reader-layout").prepend(this.toc);
    this.contentsButton.setAttribute("aria-expanded", "false");
  }

  dismiss() {
    this.preview.hide();
    this.closeContents();
    this.controller?.abort();
    this.dialog.close();
  }

  currentLocation() {
    return this.location;
  }

  async load(node, signal) {
    if (!node.article)
      throw new Error("This node has no article in this snapshot.");
    let data = this.cache.get(node.id);
    if (data) return data;
    const response = await fetch(
      `./data/articles/${encodeURIComponent(node.id)}.json`,
      { signal },
    );
    if (!response.ok) throw new Error("The article file could not be loaded.");
    data = validateArticle(await response.json(), node.id, this.ids);
    if (this.cache.size >= 12)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(node.id, data);
    return data;
  }

  async open(node, blockIndex = null, highlight = null) {
    if (!node.article) {
      this.close();
      this.onNavigate(node.id);
      return;
    }
    if (this.onOpen) return this.onOpen(node, blockIndex, highlight);
    return this.show(node, blockIndex, highlight);
  }

  async show(node, blockIndex = null, highlight = null) {
    this.preview.hide();
    this.closeContents();
    this.contentsButton.disabled = true;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.location = { id: node.id, blockIndex, highlight: null };
    this.title.textContent = node.title;
    this.original.href = node.url;
    this.content.replaceChildren(
      element("p", "reader-loading", "Loading article…"),
    );
    this.toc.replaceChildren();
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector(".reader-article")?.scrollTo(0, 0);
    try {
      const data = await this.load(node, controller.signal);
      if (controller.signal.aborted) return;
      const block = Number.isSafeInteger(blockIndex)
        ? data.blocks[blockIndex]
        : null;
      const selected =
        block && validHighlight(block, highlight)
          ? {
              start: highlight.start,
              end: highlight.end,
              target: highlight.target,
            }
          : null;
      this.location = { id: node.id, blockIndex, highlight: selected };
      this.render(data, blockIndex, selected);
      if (blockIndex !== null)
        (
          this.content.querySelector(
            ".reader-passage-highlight, .reader-mention-highlight",
          ) ??
          document.getElementById(
            typeof blockIndex === "string"
              ? `article-${blockIndex}`
              : `block-${blockIndex}`,
          )
        )?.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = element(
        "p",
        "reader-loading",
        error instanceof Error
          ? error.message
          : "The article could not be loaded.",
      );
      const retry = element("button", "secondary-button", "Try again");
      retry.addEventListener("click", () =>
        this.show(node, blockIndex, highlight),
      );
      this.content.replaceChildren(message, retry);
    }
  }

  render(data, blockIndex = null, highlight = null) {
    const fragment = document.createDocumentFragment();
    const toc = document.createDocumentFragment();
    toc.append(element("span", "eyebrow", "CONTENTS"));
    const intro = element("a", "", "Introduction");
    intro.href = "#reader-title";
    toc.append(intro);
    const copyright = element("p", "reader-copyright");
    const attribution = data.attribution;
    copyright.append(
      attribution &&
        typeof attribution.authors === "string" &&
        attribution.authors.trim() &&
        typeof attribution.year === "string" &&
        attribution.year.trim()
        ? `Article © ${attribution.year} ${attribution.authors}. `
        : "Article copyright remains with its authors. ",
      "Stanford Encyclopedia of Philosophy © Metaphysics Research Lab, Stanford University. Unaffiliated visualization. ",
    );
    const copyrightLink = element("a", "", "Copyright information");
    copyrightLink.href = "https://plato.stanford.edu/info.html#c";
    copyrightLink.target = "_blank";
    copyrightLink.rel = "noreferrer";
    copyright.append(copyrightLink);
    fragment.append(copyright);
    if (typeof data.publication === "string")
      fragment.append(element("p", "reader-loading", data.publication));
    data.blocks.forEach((block, index) => {
      const tag =
        block.kind === "quote"
          ? "blockquote"
          : block.kind === "li"
            ? "p"
            : block.kind;
      const section = element(tag);
      section.id = `block-${index}`;
      if (tag.startsWith("h")) {
        const link = element("a", "", block.text);
        link.href = `#${section.id}`;
        if (tag !== "h2")
          link.style.paddingLeft = tag === "h3" ? "10px" : "18px";
        toc.append(link);
      }
      for (const part of readerParts(
        block,
        index === blockIndex ? highlight : null,
      )) {
        const parent = part.target ? element("a", "article-mention") : section;
        if (part.target) {
          parent.href = `#/${encodeURIComponent(part.target)}`;
          parent.dataset.article = part.target;
          parent.setAttribute("aria-keyshortcuts", "ArrowDown");
        }
        for (const segment of part.segments)
          parent.append(
            segment.highlight
              ? element("mark", segment.highlight, segment.text)
              : document.createTextNode(segment.text),
          );
        if (part.target) section.append(parent);
      }
      fragment.append(section);
    });
    if (data.bibliography.length) {
      const heading = element("h2", "", "Bibliography");
      heading.id = "article-bibliography";
      fragment.append(heading);
      const link = element("a", "", "Bibliography");
      link.href = "#article-bibliography";
      toc.append(link);
      const bibliography = element("div", "bibliography");
      for (const block of data.bibliography)
        bibliography.append(element("p", "", block.text));
      fragment.append(bibliography);
    }
    if (data.related.length) {
      const heading = element("h2", "", "Related entries");
      heading.id = "article-related";
      fragment.append(heading);
      const link = element("a", "", "Related entries");
      link.href = "#article-related";
      toc.append(link);
      const list = element("ul", "related-links");
      for (const related of data.related) {
        const item = element("li");
        if (related.id || related.url) {
          const anchor = element("a", "", related.title);
          if (related.id) {
            anchor.href = `#/${encodeURIComponent(related.id)}`;
            anchor.dataset.article = related.id;
            anchor.setAttribute("aria-keyshortcuts", "ArrowDown");
          } else {
            anchor.href = related.url;
            anchor.target = "_blank";
            anchor.rel = "noreferrer";
            anchor.append(" ↗");
          }
          item.append(anchor);
        } else {
          item.append(
            element(
              "span",
              "missing-reference",
              `${related.title} (not in this snapshot)`,
            ),
          );
        }
        list.append(item);
      }
      fragment.append(list);
    }
    this.content.replaceChildren(fragment);
    this.toc.replaceChildren(toc);
    this.contentsButton.disabled = false;
    this.toc.querySelectorAll("a").forEach((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        this.closeContents();
        const id = link.getAttribute("href")?.slice(1);
        if (id && this.onLocation) {
          const blockIndex = id.startsWith("block-")
            ? Number(id.slice(6))
            : id === "reader-title"
              ? null
              : id.slice(8);
          this.onLocation(blockIndex);
        } else if (id)
          document.getElementById(id)?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "instant"
              : "smooth",
            block: "start",
          });
      }),
    );
  }
}
