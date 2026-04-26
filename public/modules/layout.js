// layout.js — split-pane tree engine
//
// Data model:
//   LeafNode  = { type: "leaf", id: string, paneId: string, sessionId: number }
//   SplitNode = { type: "split", id: string, direction: "h"|"v", ratio: 0.5, children: [PaneNode, PaneNode] }
//   PaneNode  = LeafNode | SplitNode

import { uid } from "./util.js";

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function makeLeaf(paneId, sessionId) {
  return { type: "leaf", id: uid("leaf"), paneId, sessionId };
}

export function makeSplit(direction, ratio, child0, child1) {
  return { type: "split", id: uid("split"), direction, ratio: ratio || 0.5, children: [child0, child1] };
}

/** Find a node by its id. Returns [node, parent, childIndex] or null. */
export function findNode(root, nodeId, parent, childIdx) {
  if (!root) return null;
  if (root.id === nodeId) return [root, parent || null, childIdx != null ? childIdx : -1];
  if (root.type === "split") {
    for (let i = 0; i < root.children.length; i++) {
      const result = findNode(root.children[i], nodeId, root, i);
      if (result) return result;
    }
  }
  return null;
}

/** Find a leaf node by paneId. */
export function findLeafByPane(root, paneId) {
  if (!root) return null;
  if (root.type === "leaf" && root.paneId === paneId) return root;
  if (root.type === "split") {
    for (const child of root.children) {
      const r = findLeafByPane(child, paneId);
      if (r) return r;
    }
  }
  return null;
}

/** Get all leaf nodes. */
export function allLeaves(root, out) {
  out = out || [];
  if (!root) return out;
  if (root.type === "leaf") { out.push(root); return out; }
  for (const child of root.children) allLeaves(child, out);
  return out;
}

/** Get the first (top-left-most) leaf. */
export function firstLeaf(root) {
  if (!root) return null;
  if (root.type === "leaf") return root;
  return firstLeaf(root.children[0]);
}

/** Count leaves. */
export function leafCount(root) {
  return allLeaves(root).length;
}

// ---------------------------------------------------------------------------
// Split / close operations
// ---------------------------------------------------------------------------

/**
 * Split a pane. Returns the new leaf node, or null on failure.
 * The tree is mutated in place (or root is replaced via callback).
 */
export function splitNode(root, paneId, direction, newPaneId, newSessionId, setRoot) {
  const leaf = findLeafByPane(root, paneId);
  if (!leaf) return null;

  const [node, parent, childIdx] = findNode(root, leaf.id);
  const newLeaf = makeLeaf(newPaneId, newSessionId);
  const splitN = makeSplit(direction, 0.5, { ...node }, newLeaf);

  if (!parent) {
    // Splitting the root leaf
    setRoot(splitN);
  } else {
    parent.children[childIdx] = splitN;
  }
  return newLeaf;
}

/**
 * Close a pane. Returns the paneId that should get focus, or null if tree is now empty.
 */
export function closeNode(root, paneId, setRoot) {
  const leaf = findLeafByPane(root, paneId);
  if (!leaf) return null;

  const [node, parent, childIdx] = findNode(root, leaf.id);
  if (!parent) {
    // Only leaf — can't close
    return null;
  }

  const siblingIdx = childIdx === 0 ? 1 : 0;
  const sibling = parent.children[siblingIdx];

  // Replace parent split with sibling
  const [_, grandparent, parentIdx] = findNode(root, parent.id);
  if (!grandparent) {
    setRoot(sibling);
  } else {
    grandparent.children[parentIdx] = sibling;
  }

  return firstLeaf(sibling)?.paneId || null;
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

const MIN_PANE_SIZE = 50; // px

/**
 * Render the pane tree into a container element.
 * Returns a Map of paneId -> { mountEl, leafEl } for terminal attachment.
 */
export function renderTree(root, container) {
  container.innerHTML = "";
  const mounts = new Map();
  renderNodeInto(root, container, mounts);
  return mounts;
}

function renderNodeInto(node, parent, mounts) {
  if (!node) return;

  if (node.type === "leaf") {
    const leafEl = document.createElement("div");
    leafEl.className = "pane-leaf";
    leafEl.dataset.paneId = node.paneId;

    const mountEl = document.createElement("div");
    mountEl.className = "terminal-mount";
    leafEl.appendChild(mountEl);

    // Pane header bar (small, shows session info)
    const headerEl = document.createElement("div");
    headerEl.className = "pane-header";
    headerEl.dataset.paneId = node.paneId;
    leafEl.insertBefore(headerEl, mountEl);

    parent.appendChild(leafEl);
    mounts.set(node.paneId, { mountEl, leafEl, headerEl });
    return;
  }

  // Split node
  const splitEl = document.createElement("div");
  splitEl.className = "pane-split " + (node.direction === "h" ? "horizontal" : "vertical");
  splitEl.dataset.splitId = node.id;

  // First child container
  const child0 = document.createElement("div");
  child0.className = "pane-child";
  if (node.direction === "h") {
    child0.style.width = (node.ratio * 100) + "%";
  } else {
    child0.style.height = (node.ratio * 100) + "%";
  }
  renderNodeInto(node.children[0], child0, mounts);
  splitEl.appendChild(child0);

  // Divider
  const divider = document.createElement("div");
  divider.className = "pane-divider " + (node.direction === "h" ? "horizontal" : "vertical");
  divider.dataset.splitId = node.id;
  splitEl.appendChild(divider);

  // Second child container
  const child1 = document.createElement("div");
  child1.className = "pane-child";
  child1.style.flex = "1";
  renderNodeInto(node.children[1], child1, mounts);
  splitEl.appendChild(child1);

  parent.appendChild(splitEl);
}

// ---------------------------------------------------------------------------
// Divider drag-to-resize
// ---------------------------------------------------------------------------

export function initDividerResize(container, getTree, onResize) {
  let dragging = null;

  container.addEventListener("pointerdown", (e) => {
    const divider = e.target.closest(".pane-divider");
    if (!divider) return;

    e.preventDefault();
    divider.setPointerCapture(e.pointerId);

    const splitId = divider.dataset.splitId;
    const splitEl = divider.closest(".pane-split");
    const rect = splitEl.getBoundingClientRect();
    const isH = divider.classList.contains("horizontal");

    dragging = { splitId, rect, isH, divider };
    divider.classList.add("active");
    document.body.style.cursor = isH ? "col-resize" : "row-resize";
  });

  container.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const { splitId, rect, isH } = dragging;

    let ratio;
    if (isH) {
      ratio = (e.clientX - rect.left) / rect.width;
    } else {
      ratio = (e.clientY - rect.top) / rect.height;
    }
    ratio = Math.max(0.1, Math.min(0.9, ratio));

    // Update tree node
    const tree = getTree();
    const found = findNode(tree, splitId);
    if (found) {
      found[0].ratio = ratio;
      // Update DOM directly for performance (no full re-render)
      const splitEl = dragging.divider.closest(".pane-split");
      const firstChild = splitEl.querySelector(":scope > .pane-child");
      if (isH) {
        firstChild.style.width = (ratio * 100) + "%";
      } else {
        firstChild.style.height = (ratio * 100) + "%";
      }
    }
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging.divider.classList.remove("active");
    document.body.style.cursor = "";
    dragging = null;
    if (onResize) onResize();
  };

  container.addEventListener("pointerup", stopDrag);
  container.addEventListener("pointercancel", stopDrag);
}

// ---------------------------------------------------------------------------
// Geometric pane navigation
// ---------------------------------------------------------------------------

/**
 * Given a container with rendered panes, find the neighbor in the given direction.
 * direction: "up" | "down" | "left" | "right"
 */
export function findNeighborPane(container, activePaneId, direction) {
  const allPanes = container.querySelectorAll(".pane-leaf");
  if (allPanes.length < 2) return null;

  const activeEl = container.querySelector(`.pane-leaf[data-pane-id="${activePaneId}"]`);
  if (!activeEl) return null;

  const activeRect = activeEl.getBoundingClientRect();
  const cx = activeRect.left + activeRect.width / 2;
  const cy = activeRect.top + activeRect.height / 2;

  let best = null;
  let bestDist = Infinity;

  for (const pane of allPanes) {
    if (pane === activeEl) continue;
    const r = pane.getBoundingClientRect();
    const px = r.left + r.width / 2;
    const py = r.top + r.height / 2;

    // Check direction
    let valid = false;
    if (direction === "left" && px < cx - 10) valid = true;
    if (direction === "right" && px > cx + 10) valid = true;
    if (direction === "up" && py < cy - 10) valid = true;
    if (direction === "down" && py > cy + 10) valid = true;

    if (valid) {
      const dist = Math.hypot(px - cx, py - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = pane.dataset.paneId;
      }
    }
  }

  return best;
}
