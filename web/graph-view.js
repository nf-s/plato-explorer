import { nodeColor } from "./categories.js";
const TAU = Math.PI * 2;

export class GraphView {
  constructor(canvas, graph, onSelect, onHover) {
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Your browser could not start the graph canvas.");
    this.canvas = canvas;
    this.context = context;
    this.graph = graph;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.visible = { nodes: [], edges: [] };
    this.positions = new Map();
    this.selected = null;
    this.hovered = null;
    this.labels = true;
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.width = 1;
    this.height = 1;
    this.frame = null;
    this.pointer = null;
    this.pointers = new Map();
    this.pinch = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bindEvents();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previousWidth = this.width;
    const previousHeight = this.height;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    if (previousWidth <= 1 || previousHeight <= 1) this.fit();
    else {
      this.offset.x += (this.width - previousWidth) / 2;
      this.offset.y += (this.height - previousHeight) / 2;
      this.drawSoon();
    }
  }

  camera() {
    return {
      scale: this.scale,
      x: this.offset.x,
      y: this.offset.y,
      width: this.width,
      height: this.height,
    };
  }

  restoreCamera(camera) {
    this.resize();
    this.scale = camera.scale;
    this.offset = {
      x: camera.x + (this.width - camera.width) / 2,
      y: camera.y + (this.height - camera.height) / 2,
    };
    this.drawSoon();
  }

  setView(visible, selected, labels, fit = true) {
    this.visible = visible;
    this.selected = selected;
    this.labels = labels;
    this.hovered = null;
    this.onHover(null);
    this.positions.clear();
    if (selected === null) {
      for (const index of visible.nodes)
        this.positions.set(index, {
          x: this.graph.nodes[index].x,
          y: this.graph.nodes[index].y,
        });
    } else {
      this.positions.set(selected, { x: 0, y: 0 });
      const neighbors = visible.nodes.filter((index) => index !== selected);
      neighbors.forEach((index, rank) => {
        const angle = rank * 2.399963229728653;
        const radius = 100 + Math.sqrt(rank + 1) * 33;
        this.positions.set(index, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      });
    }
    this.labelOrder =
      selected === null
        ? [...visible.nodes].sort(
            (a, b) =>
              this.graph.nodes[b].mentions - this.graph.nodes[a].mentions,
          )
        : [...visible.nodes];
    this.batches = this.edgeBatches();
    if (fit) this.fit();
    else this.drawSoon();
  }

  edgeBatches() {
    const batches = new Map();
    for (const edge of this.visible.edges) {
      const direct =
        this.selected !== null &&
        (edge[0] === this.selected || edge[1] === this.selected);
      const weight = edge[2] + edge[3];
      const tier =
        weight === 0 ? 0 : Math.min(4, Math.ceil(Math.log10(weight + 1)));
      const color = direct ? "#778a94" : "#8398b0";
      const key = `${tier}:${color}:${direct}`;
      if (!batches.has(key))
        batches.set(key, { edges: [], tier, color, direct });
      batches.get(key).edges.push(edge);
    }
    return [...batches.values()].sort(
      (a, b) => Number(a.direct) - Number(b.direct),
    );
  }

  fit() {
    if (!this.positions.size) return;
    const positions = [...this.positions.values()];
    const minX = Math.min(...positions.map((point) => point.x));
    const maxX = Math.max(...positions.map((point) => point.x));
    const minY = Math.min(...positions.map((point) => point.y));
    const maxY = Math.max(...positions.map((point) => point.y));
    const mobile = window.matchMedia(
      "(max-width: 760px), (max-width: 1000px) and (max-height: 600px) and (pointer: coarse)",
    ).matches;
    const top = mobile ? 116 : 145;
    const bottom = mobile ? 68 : 105;
    this.scale = Math.min(
      (this.width - 100) / Math.max(maxX - minX + 80, 300),
      (this.height - top - bottom) / Math.max(maxY - minY + 80, 300),
    );
    this.scale = Math.max(this.scale, 0.03);
    this.offset = {
      x: this.width / 2 - ((minX + maxX) / 2) * this.scale,
      y:
        top +
        (this.height - top - bottom) / 2 -
        ((minY + maxY) / 2) * this.scale,
    };
    this.drawSoon();
  }

  color(index) {
    return index === this.selected || index === this.hovered
      ? "#526e78"
      : nodeColor(this.graph.nodes[index], this.colorMode ?? "subject");
  }

  point(index) {
    const position = this.positions.get(index);
    if (!position) return { x: -1000, y: -1000 };
    return {
      x: position.x * this.scale + this.offset.x,
      y: position.y * this.scale + this.offset.y,
    };
  }

  radius(index) {
    const mentions = this.graph.nodes[index].mentions;
    const base = 2.2 + Math.pow(mentions, 0.43) * 0.18;
    return (
      Math.max(2, Math.min(25, base) * Math.pow(this.scale, 0.25)) +
      (index === this.selected ? 4 : 0)
    );
  }

  drawSoon() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const ctx = this.context;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const points = new Map(
      this.visible.nodes.map((index) => [index, this.point(index)]),
    );
    const highlighted = this.hovered === null ? this.selected : this.hovered;
    const adjacent = new Set(highlighted === null ? [] : [highlighted]);
    const highlightEdges = [];
    if (this.hovered !== null) {
      for (const edge of this.visible.edges) {
        if (edge[0] === this.hovered || edge[1] === this.hovered) {
          adjacent.add(edge[0]);
          adjacent.add(edge[1]);
          highlightEdges.push(edge);
        }
      }
    }
    const edgeCount = this.visible.edges.length;
    const density = edgeCount > 30000 ? 0.035 : edgeCount > 5000 ? 0.065 : 0.14;
    for (const batch of this.batches || []) {
      ctx.beginPath();
      ctx.strokeStyle = batch.color;
      ctx.globalAlpha =
        this.hovered !== null
          ? density * 0.25
          : batch.direct
            ? 0.28 + batch.tier * 0.07
            : density;
      ctx.lineWidth = batch.direct
        ? 0.5 + batch.tier * 0.55
        : 0.35 + batch.tier * 0.14;
      ctx.setLineDash(
        batch.tier === 0 && (batch.direct || edgeCount < 1000) ? [3, 4] : [],
      );
      for (const edge of batch.edges) {
        const a = points.get(edge[0]);
        const b = points.get(edge[1]);
        if (a && b) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      }
      ctx.stroke();
    }
    for (const edge of highlightEdges) {
      const a = points.get(edge[0]);
      const b = points.get(edge[1]);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = this.color(
        edge[0] === this.hovered ? edge[1] : edge[0],
      );
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.7 + Math.log1p(edge[2] + edge[3]) * 0.35;
      ctx.setLineDash(edge[2] + edge[3] === 0 ? [3, 4] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const index of [...this.labelOrder].reverse()) {
      const point = points.get(index);
      if (
        !point ||
        point.x < -30 ||
        point.x > this.width + 30 ||
        point.y < -30 ||
        point.y > this.height + 30
      )
        continue;
      const radius = this.radius(index);
      const active = index === highlighted || index === this.selected;
      ctx.globalAlpha = this.hovered !== null && !adjacent.has(index) ? 0.2 : 1;
      if (active) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 5, 0, TAU);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = this.color(index);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, TAU);
      ctx.fillStyle = this.color(index);
      ctx.fill();
      ctx.strokeStyle = "#ffffffcc";
      ctx.lineWidth = radius > 5 ? 1.2 : 0.6;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (this.labels) this.drawLabels(ctx, points, adjacent);
  }

  drawLabels(ctx, points, adjacent) {
    const occupied = [];
    const priority = [this.hovered, this.selected, ...this.labelOrder].filter(
      (index, position, list) =>
        index !== null && list.indexOf(index) === position,
    );
    let count = 0;
    for (const index of priority) {
      const point = points.get(index);
      if (!point) continue;
      const isActive = index === this.hovered || index === this.selected;
      if (!isActive && this.hovered !== null && !adjacent.has(index)) continue;
      if (count >= (this.scale > 1 ? 100 : 45) && !isActive) break;
      const size = isActive
        ? 13
        : this.graph.nodes[index].mentions > 10000
          ? 12
          : 10;
      ctx.font = `${isActive ? 600 : 400} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      const text = this.graph.nodes[index].title;
      const width = ctx.measureText(text).width;
      const x = point.x + this.radius(index) + 5;
      const y = point.y + size / 3;
      if (
        x < 15 ||
        x + width > this.width - 15 ||
        y < (this.width < 600 ? 122 : 145) ||
        y > this.height - 100
      )
        continue;
      const box = {
        x: x - 4,
        y: y - size - 3,
        width: width + 8,
        height: size + 8,
      };
      if (
        !isActive &&
        occupied.some(
          (other) =>
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y,
        )
      )
        continue;
      occupied.push(box);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#f6f8fbf2";
      ctx.lineJoin = "round";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = isActive ? "#354f5b" : "#526174";
      ctx.fillText(text, x, y);
      count += 1;
    }
  }

  hit(x, y) {
    let best = null;
    let distance = Infinity;
    for (const index of this.visible.nodes) {
      const point = this.point(index);
      const squared = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (squared < (this.radius(index) + 5) ** 2 && squared < distance) {
        best = index;
        distance = squared;
      }
    }
    return best;
  }

  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const next = Math.max(0.025, Math.min(12, this.scale * factor));
    const ratio = next / this.scale;
    this.offset.x = x - (x - this.offset.x) * ratio;
    this.offset.y = y - (y - this.offset.y) * ratio;
    this.scale = next;
    this.onHover(null);
    this.drawSoon();
  }

  bindEvents() {
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoom(
          Math.exp(-event.deltaY * 0.0015),
          event.offsetX,
          event.offsetY,
        );
      },
      { passive: false },
    );
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, {
        x: event.offsetX,
        y: event.offsetY,
      });
      this.pointer = { x: event.clientX, y: event.clientY, moved: false };
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
        this.pointer.moved = true;
      }
      this.onHover(null);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.pointers.has(event.pointerId))
        this.pointers.set(event.pointerId, {
          x: event.offsetX,
          y: event.offsetY,
        });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch)
          this.zoom(distance / this.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinch = distance;
        return;
      }
      if (this.pointer) {
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        if (this.pointer.moved || Math.abs(dx) + Math.abs(dy) > 3) {
          this.pointer.moved = true;
          this.offset.x += dx;
          this.offset.y += dy;
          this.pointer.x = event.clientX;
          this.pointer.y = event.clientY;
          this.drawSoon();
        }
        return;
      }
      const hit = this.hit(event.offsetX, event.offsetY);
      if (this.hovered !== hit) {
        this.hovered = hit;
        this.drawSoon();
      }
      this.canvas.style.cursor = hit === null ? "grab" : "pointer";
      this.onHover(
        hit === null
          ? null
          : {
              node: this.graph.nodes[hit],
              x: event.offsetX,
              y: event.offsetY,
              width: this.width,
              height: this.height,
            },
      );
    });
    const release = (event) => {
      this.pointers.delete(event.pointerId);
      if (
        this.pointer &&
        !this.pointer.moved &&
        event.type !== "pointercancel"
      ) {
        const hit = this.hit(event.offsetX, event.offsetY);
        if (hit !== null) this.onSelect(hit, event.shiftKey);
      }
      this.pointer = null;
      this.pinch = null;
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);
    this.canvas.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.onHover(null);
      this.drawSoon();
    });
    this.canvas.addEventListener("keydown", (event) => {
      if (
        [
          "+",
          "=",
          "-",
          "Home",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(event.key)
      )
        event.preventDefault();
      if (event.key === "+" || event.key === "=") this.zoom(1.3);
      if (event.key === "-") this.zoom(1 / 1.3);
      if (event.key === "Home") this.fit();
      if (event.key === "ArrowUp") this.offset.y += 40;
      if (event.key === "ArrowDown") this.offset.y -= 40;
      if (event.key === "ArrowLeft") this.offset.x += 40;
      if (event.key === "ArrowRight") this.offset.x -= 40;
      this.drawSoon();
    });
  }
}
