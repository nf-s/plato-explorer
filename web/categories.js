export const subjects = new Map([
  ["Ethics & society", "#b97559"],
  ["Mind & knowledge", "#638f9e"],
  ["Logic & language", "#7b75a6"],
  ["Science & mathematics", "#578b76"],
  ["Metaphysics", "#b29854"],
  ["Religion", "#a57290"],
  ["Arts & aesthetics", "#6887b3"],
  ["History & traditions", "#998678"],
  ["Other / interdisciplinary", "#94a0ac"],
]);

export function category(node, mode) {
  if (mode === "subject") return node.subject;
  if (mode === "type")
    return { person: "People", topic: "Topics", keyword: "Keywords" }[
      node.kind
    ];
  if (mode === "connections") {
    if (node.degree >= 500) return "500+ connections";
    if (node.degree >= 200) return "200–499 connections";
    if (node.degree >= 50) return "50–199 connections";
    return "0–49 connections";
  }
  return "All articles";
}

export function palette(mode) {
  if (mode === "subject") return subjects;
  if (mode === "type")
    return new Map([
      ["People", "#6887b3"],
      ["Topics", "#b29854"],
      ["Keywords", "#8c9c93"],
    ]);
  if (mode === "connections")
    return new Map([
      ["0–49 connections", "#b4c8cf"],
      ["50–199 connections", "#7b9dab"],
      ["200–499 connections", "#50778e"],
      ["500+ connections", "#304b72"],
    ]);
  return new Map([["All articles", "#8195ad"]]);
}

export function nodeColor(node, mode) {
  return palette(mode).get(category(node, mode)) ?? "#8195ad";
}
