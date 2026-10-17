/**
 * The browser's saved tab layout (workspaces → split panes → sessions). The server only stores it and, on restart,
 * uses it to decide which sessions are still shown.
 */
export class WorkspaceLayout {
  private value: unknown | null;

  constructor(initial: unknown | null = null) { this.value = initial || null; }

  get(): unknown | null { return this.value; }

  set(layout: unknown): void { this.value = layout || null; }

  /** Ids of every session that a pane in the saved layout still shows. */
  sessionIds(): Set<number> {
    const ids = new Set<number>();
    const collect = (node: any): void => {
      if (!node) return;
      if (node.type === "leaf" && node.sessionId != null) ids.add(node.sessionId);
      if (node.children) node.children.forEach(collect);
    };
    if (Array.isArray(this.value)) for (const w of this.value) if (w && w.rootNode) collect(w.rootNode);
    return ids;
  }
}
