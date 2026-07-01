// Minimal hyperscript helper so the control rail reads declaratively without a framework.
type Attrs = Record<string, unknown>;

export function el(tag: string, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "value") (node as HTMLInputElement).value = String(v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/** A labelled control row with an optional unobtrusive "?" help tooltip. */
export function field(label: string, control: Node, help?: string, wide = false): HTMLElement {
  const lbl = el("label", { text: label });
  if (help) lbl.append(el("span", { class: "help", text: "?", title: help }));
  return el("div", { class: wide ? "field field--wide" : "field" }, wide ? [lbl, control] : [lbl, control]);
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
