import {
  connectionBetween,
  createIndex,
  element,
  number,
} from "./data-model.js";

const previewDelay = 550;

export function articleExcerpt(article, fallback = "") {
  const opening =
    article.blocks
      .find((block) => !block.kind.startsWith("h") && block.text.trim())
      ?.text.trim() || fallback;
  if (opening.length <= 480) return opening;
  const end = opening.lastIndexOf(" ", 480);
  return `${opening.slice(0, end > 350 ? end : 480).trimEnd()}…`;
}

export class ArticlePreview {
  constructor(reader) {
    this.reader = reader;
    this.index = createIndex(reader.graph);
    this.anchor = null;
    this.timer = null;
    this.closeTimer = null;
    this.controller = null;
    this.press = null;
    this.suppressedClick = null;
    this.pinned = false;
    this.card = element("section", "article-preview");
    this.card.id = "article-preview";
    this.card.hidden = true;
    this.card.tabIndex = -1;
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-labelledby", "article-preview-title");
    reader.dialog.append(this.card);

    reader.content.addEventListener("pointerover", (event) => {
      if (
        event.pointerType === "touch" ||
        event.buttons ||
        this.press ||
        this.pinned
      )
        return;
      const anchor = this.link(event.target);
      if (anchor && !anchor.contains(event.relatedTarget))
        this.schedule(anchor);
    });
    reader.content.addEventListener("pointerout", (event) => {
      const anchor = this.link(event.target);
      if (anchor && !anchor.contains(event.relatedTarget) && !this.press)
        this.leave();
    });
    reader.content.addEventListener("focusin", (event) => {
      const anchor = this.link(event.target);
      if (anchor && !this.press) this.schedule(anchor);
    });
    reader.content.addEventListener("focusout", (event) => {
      if (!this.card.contains(event.relatedTarget)) this.leave();
    });
    reader.content.addEventListener("keydown", (event) => {
      const anchor = this.link(event.target);
      if (anchor && event.key === "ArrowDown") {
        event.preventDefault();
        this.show(anchor, true);
        this.card.focus({ preventScroll: true });
      }
    });
    reader.content.addEventListener("pointerdown", (event) => {
      this.suppressedClick = null;
      const anchor = this.link(event.target);
      if (
        !anchor ||
        event.button !== 0 ||
        !event.isPrimary ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      clearTimeout(this.timer);
      this.press = {
        anchor,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        opened: false,
      };
      this.timer = setTimeout(() => {
        if (!this.press) return;
        this.press.opened = true;
        this.suppressedClick = anchor;
        this.show(anchor, true);
      }, previewDelay);
    });
    document.addEventListener("pointermove", (event) => {
      if (!this.press || event.pointerId !== this.press.pointerId) return;
      if (
        Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >
        10
      )
        this.cancelPress();
    });
    document.addEventListener("pointerup", (event) => {
      if (!this.press || event.pointerId !== this.press.pointerId) return;
      if (this.press.opened) event.preventDefault();
      this.cancelPress();
    });
    document.addEventListener("pointercancel", () => this.cancelPress());
    reader.content.addEventListener("contextmenu", (event) => {
      const anchor = this.link(event.target);
      if (this.press || (anchor && anchor === this.suppressedClick))
        event.preventDefault();
    });
    reader.content.addEventListener(
      "click",
      (event) => {
        const anchor = this.link(event.target);
        if (anchor && anchor === this.suppressedClick && event.detail !== 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.suppressedClick = null;
        } else if (anchor) {
          this.hide();
        }
      },
      true,
    );
    reader.dialog.addEventListener(
      "pointerdown",
      (event) => {
        if (
          !this.card.hidden &&
          !this.card.contains(event.target) &&
          !this.anchor?.contains(event.target)
        )
          this.hide();
      },
      true,
    );
    reader.dialog.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !this.card.hidden) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.hide(true);
        }
      },
      true,
    );
    this.card.addEventListener("pointerenter", () =>
      clearTimeout(this.closeTimer),
    );
    this.card.addEventListener("pointerleave", () => this.leave());
    this.card.addEventListener("focusin", () => clearTimeout(this.closeTimer));
    this.card.addEventListener("focusout", (event) => {
      if (
        !this.card.contains(event.relatedTarget) &&
        event.relatedTarget !== this.anchor
      )
        this.hide();
    });
    reader.dialog
      .querySelector(".reader-article")
      .addEventListener("scroll", () => this.hide());
    window.addEventListener("resize", () => this.hide());
  }

  link(target) {
    return target instanceof Element ? target.closest("a[data-article]") : null;
  }

  schedule(anchor) {
    clearTimeout(this.closeTimer);
    clearTimeout(this.timer);
    if (anchor === this.anchor && !this.card.hidden) return;
    this.hide();
    this.timer = setTimeout(() => this.show(anchor), previewDelay);
  }

  leave() {
    clearTimeout(this.timer);
    if (this.pinned || this.card.contains(document.activeElement)) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.hide(), 220);
  }

  cancelPress() {
    clearTimeout(this.timer);
    this.press = null;
  }

  hide(restoreFocus = false) {
    const focusInCard = this.card.contains(document.activeElement);
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    this.controller?.abort();
    this.controller = null;
    this.cancelPress();
    this.card.hidden = true;
    this.pinned = false;
    const anchor = this.anchor;
    this.anchor = null;
    anchor?.removeAttribute("aria-expanded");
    anchor?.removeAttribute("aria-controls");
    if ((restoreFocus || focusInCard) && anchor?.isConnected) {
      anchor.focus({ preventScroll: true });
      clearTimeout(this.timer);
    }
  }

  position() {
    if (!this.anchor || this.card.hidden) return;
    const bounds = this.anchor.getBoundingClientRect();
    const width = this.card.offsetWidth;
    const height = this.card.offsetHeight;
    const left = Math.max(
      12,
      Math.min(bounds.left, window.innerWidth - width - 12),
    );
    const below = bounds.bottom + 8;
    const top =
      below + height <= window.innerHeight - 12
        ? below
        : Math.max(12, bounds.top - height - 8);
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }

  async show(anchor, pinned = false) {
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    const target =
      this.reader.graph.nodes[this.index.byId.get(anchor.dataset.article)];
    const source =
      this.reader.graph.nodes[
        this.index.byId.get(this.reader.currentLocation()?.id)
      ];
    if (!target || !source || !anchor.isConnected || !this.reader.dialog.open)
      return;
    this.controller?.abort();
    this.anchor?.removeAttribute("aria-expanded");
    this.anchor?.removeAttribute("aria-controls");
    this.anchor = anchor;
    this.pinned = pinned;
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", this.card.id);
    const controller = new AbortController();
    this.controller = controller;
    const header = element("div", "article-preview-header");
    const title = element("h2", "", target.title);
    title.id = "article-preview-title";
    const close = element("button", "quiet-button", "×");
    close.setAttribute("aria-label", "Close preview");
    close.addEventListener("click", () => this.hide(true));
    header.append(title, close);
    const excerpt = element("p", "article-preview-excerpt");
    const credit = element("p", "article-preview-credit");
    credit.hidden = true;
    const status = element(
      "p",
      "article-preview-status",
      target.article ? "Loading preview…" : "No article in this snapshot.",
    );
    status.setAttribute("role", "status");
    const counts = element("div", "article-preview-connections");
    const connection = connectionBetween(
      this.reader.graph,
      this.index,
      source.id,
      target.id,
    );
    if (connection) {
      for (const [from, to, count, related] of [
        [source, target, connection.outgoing, connection.relatedOut],
        [target, source, connection.incoming, connection.relatedIn],
      ]) {
        if (!from.article) continue;
        counts.append(
          element(
            "p",
            "",
            `${from.title} → ${to.title}: ${number(count)} text ${count === 1 ? "mention" : "mentions"}${related ? " · Related entry" : ""}`,
          ),
        );
      }
    }
    const actions = element("div", "article-preview-actions");
    if (target.article) {
      const read = element("button", "primary-button", "Read article");
      read.addEventListener("click", () => {
        this.hide();
        this.reader.dialog
          .querySelector("#reader-close")
          .focus({ preventScroll: true });
        this.reader.open(target);
      });
      actions.append(read);
    }
    const explore = element("button", "secondary-button", "Connections");
    explore.addEventListener("click", () => {
      this.hide();
      this.reader.onNavigate(target.id);
    });
    actions.append(explore);
    this.card.replaceChildren(header, excerpt, credit, status, counts, actions);
    this.card.hidden = false;
    this.position();
    if (!target.article) return;
    try {
      const data = await this.reader.load(target, controller.signal);
      if (controller.signal.aborted) return;
      excerpt.textContent = articleExcerpt(data, target.summary);
      const attribution = data.attribution;
      if (
        attribution &&
        typeof attribution.authors === "string" &&
        attribution.authors.trim()
      ) {
        credit.textContent = `© ${typeof attribution.year === "string" ? `${attribution.year} ` : ""}${attribution.authors} · SEP`;
        credit.hidden = false;
      }
      status.hidden = Boolean(excerpt.textContent);
      status.textContent = "No introduction in this snapshot.";
      this.position();
    } catch {
      if (controller.signal.aborted) return;
      excerpt.textContent = target.summary;
      status.textContent = "Article preview could not be loaded.";
      this.position();
    }
  }
}
