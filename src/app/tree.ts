import type { ConnectionNode, NodeKind, NodeMoveRequest } from '../types';
import type { MenuAction } from './context-menu';

type DropZone = 'before' | 'after' | 'into';

type DropTarget = {
  id: string | null;
  zone: DropZone;
  isVirtualRoot: boolean;
  intoPlacement?: 'start' | 'end';
};

type TreeIndexes = {
  byId: Map<string, ConnectionNode>;
  byParent: Map<string | null, ConnectionNode[]>;
};

type DropIndicatorKind = DropZone | 'into-start';

type PointerDragCandidate = {
  nodeId: string;
  row: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
};

type PointerDragState = {
  nodeId: string;
  row: HTMLDivElement;
  pointerId: number;
  dropTarget: DropTarget | null;
};

type TreeRowOpts = {
  id: string | null;
  label: string;
  kind: NodeKind;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  isSelected: boolean;
  isVirtualRoot: boolean;
  isFiltering: boolean;
};

export type TreeControllerDeps = {
  listTree: () => Promise<ConnectionNode[]>;
  moveNode: (request: NodeMoveRequest) => Promise<void>;
  getTreeEl: () => HTMLDivElement | null;
  getTreeSearchQuery: () => string;
  getNodes: () => ConnectionNode[];
  setNodes: (nodes: ConnectionNode[]) => void;
  expandedFolders: Set<string | null>;
  getSelectedNodeId: () => string | null;
  setSelectedNodeId: (id: string | null) => void;
  bumpConnectionCheckRequestSeq: () => void;
  clearConnectionCheckStatus: () => void;
  checkSelectedConnection: (nodeId: string, connectionName: string) => Promise<void>;
  svgIcon: (kind: NodeKind) => string;
  openConnectionNode: (node: ConnectionNode) => void;
  showContextMenu: (x: number, y: number, actions: MenuAction[]) => void;
  buildFolderMenuActions: (node: ConnectionNode | null, isRoot: boolean) => MenuAction[];
  buildConnectionMenuActions: (node: ConnectionNode) => MenuAction[];
  writeStatus: (message: string) => void;
  formatError: (error: unknown) => string;
};

export type TreeController = {
  refreshTree: () => Promise<void>;
  renderTree: () => void;
};

export function createTreeController(deps: TreeControllerDeps): TreeController {
  const POINTER_DRAG_THRESHOLD_PX = 5;
  const SUPPRESS_CLICK_AFTER_DRAG_MS = 250;
  const TREE_DRAG_ACTIVE_CLASS = 'tree-drag-active';

  let draggingNodeId: string | null = null;
  let draggingRowEl: HTMLDivElement | null = null;
  let activeDropIndicator: { row: HTMLDivElement; kind: DropIndicatorKind } | null = null;
  let moveInFlight = false;
  let cachedTreeIndexesNodesRef: ConnectionNode[] | null = null;
  let cachedTreeIndexes: TreeIndexes | null = null;
  let pointerDragCandidate: PointerDragCandidate | null = null;
  let pointerDragState: PointerDragState | null = null;
  let pointerDragListenersAttached = false;
  let suppressClickUntilMs = 0;

  async function refreshTree(): Promise<void> {
    deps.setNodes(await deps.listTree());
    renderTree();
  }

  function compareNodes(a: ConnectionNode, b: ConnectionNode): number {
    if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
    return a.name.localeCompare(b.name);
  }

  function buildTreeIndexes(nodes: ConnectionNode[]): TreeIndexes {
    const byId = new Map<string, ConnectionNode>();
    const byParent = new Map<string | null, ConnectionNode[]>();

    for (const node of nodes) {
      byId.set(node.id, node);
      const children = byParent.get(node.parentId) ?? [];
      children.push(node);
      byParent.set(node.parentId, children);
    }

    for (const children of byParent.values()) {
      children.sort(compareNodes);
    }

    return { byId, byParent };
  }

  function getTreeIndexes(nodes: ConnectionNode[]): TreeIndexes {
    if (cachedTreeIndexes && cachedTreeIndexesNodesRef === nodes) {
      return cachedTreeIndexes;
    }

    // `nodes` is expected to be replaced, not mutated in place.
    const indexes = buildTreeIndexes(nodes);
    cachedTreeIndexesNodesRef = nodes;
    cachedTreeIndexes = indexes;
    return indexes;
  }

  function clearDropIndicator(): void {
    if (!activeDropIndicator) return;
    activeDropIndicator.row.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-into-start');
    activeDropIndicator = null;
  }

  function setDropIndicator(row: HTMLDivElement, kind: DropIndicatorKind): void {
    if (activeDropIndicator?.row === row && activeDropIndicator.kind === kind) {
      return;
    }

    clearDropIndicator();
    row.classList.add(`drop-${kind}`);
    activeDropIndicator = { row, kind };
  }

  function clearDragState(): void {
    draggingNodeId = null;
    if (draggingRowEl) {
      draggingRowEl.classList.remove('dragging');
    }
    draggingRowEl = null;
    clearDropIndicator();
  }

  function setTreeDragCursorActive(active: boolean): void {
    deps.getTreeEl()?.classList.toggle(TREE_DRAG_ACTIVE_CLASS, active);
  }

  function shouldSuppressClick(): boolean {
    return Date.now() < suppressClickUntilMs;
  }

  function suppressNextClickAfterDrag(): void {
    suppressClickUntilMs = Date.now() + SUPPRESS_CLICK_AFTER_DRAG_MS;
  }

  function computeDropZone(
    row: HTMLDivElement,
    clientY: number,
    allowInto: boolean,
  ): DropZone {
    const rect = row.getBoundingClientRect();
    const y = clientY - rect.top;
    const height = Math.max(rect.height, 1);
    const topBand = height * 0.25;
    const bottomBand = height * 0.75;

    if (y <= topBand) return 'before';
    if (y >= bottomBand) return 'after';
    if (allowInto) return 'into';
    return y < height / 2 ? 'before' : 'after';
  }

  function isDescendantParent(
    candidateParentId: string | null,
    ancestorNodeId: string,
    byId: Map<string, ConnectionNode>,
  ): boolean {
    let cursor = candidateParentId;
    while (cursor !== null) {
      if (cursor === ancestorNodeId) return true;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  function buildMoveRequest(
    draggedNodeId: string,
    dropTarget: DropTarget,
  ): NodeMoveRequest | null {
    const nodes = deps.getNodes();
    const { byId, byParent } = getTreeIndexes(nodes);
    const draggedNode = byId.get(draggedNodeId);
    if (!draggedNode) return null;

    if (dropTarget.id === draggedNodeId) {
      return null;
    }

    let newParentId: string | null;
    let newIndex: number;

    if (dropTarget.isVirtualRoot) {
      newParentId = null;
      const rootChildren = (byParent.get(null) ?? []).filter((node) => node.id !== draggedNodeId);
      newIndex = rootChildren.length;
    } else if (dropTarget.zone === 'into') {
      const targetNode = dropTarget.id ? byId.get(dropTarget.id) : null;
      if (!targetNode || targetNode.kind !== 'folder') return null;

      newParentId = targetNode.id;
      const targetChildren = (byParent.get(targetNode.id) ?? []).filter((node) => node.id !== draggedNodeId);
      newIndex = dropTarget.intoPlacement === 'start' ? 0 : targetChildren.length;
    } else {
      const targetNode = dropTarget.id ? byId.get(dropTarget.id) : null;
      if (!targetNode) return null;

      const siblings = byParent.get(targetNode.parentId) ?? [];
      const targetIndex = siblings.findIndex((node) => node.id === targetNode.id);
      if (targetIndex < 0) return null;

      newParentId = targetNode.parentId;
      const sameParent = draggedNode.parentId === targetNode.parentId;

      if (sameParent) {
        const draggedIndex = siblings.findIndex((node) => node.id === draggedNode.id);
        if (draggedIndex < 0) return null;

        let adjustedTargetIndex = targetIndex;
        if (draggedIndex < targetIndex) {
          adjustedTargetIndex -= 1;
        }

        newIndex = dropTarget.zone === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
      } else {
        newIndex = dropTarget.zone === 'before' ? targetIndex : targetIndex + 1;
      }
    }

    if (draggedNode.kind === 'folder' && isDescendantParent(newParentId, draggedNode.id, byId)) {
      return null;
    }

    if (draggedNode.parentId === newParentId) {
      const siblings = byParent.get(newParentId) ?? [];
      const originalOrder = siblings.map((node) => node.id);
      const currentIndex = originalOrder.indexOf(draggedNode.id);
      if (currentIndex >= 0) {
        const reordered = [...originalOrder];
        reordered.splice(currentIndex, 1);
        const insertAt = Math.min(Math.max(newIndex, 0), reordered.length);
        reordered.splice(insertAt, 0, draggedNode.id);
        const unchanged = reordered.length === originalOrder.length
          && reordered.every((id, index) => id === originalOrder[index]);
        if (unchanged) return null;
      }
    }

    return {
      nodeId: draggedNode.id,
      newParentId,
      newIndex,
    };
  }

  function selectNodeAndSyncConnectionCheck(selectedNodeId: string | null): void {
    deps.setSelectedNodeId(selectedNodeId);

    if (!selectedNodeId) {
      deps.bumpConnectionCheckRequestSeq();
      deps.clearConnectionCheckStatus();
      return;
    }

    const node = deps.getNodes().find((candidate) => candidate.id === selectedNodeId);
    if (!node || (node.kind !== 'ssh' && node.kind !== 'rdp')) {
      deps.bumpConnectionCheckRequestSeq();
      deps.clearConnectionCheckStatus();
      return;
    }

    void deps.checkSelectedConnection(node.id, node.name);
  }

  async function handleDrop(draggedNodeId: string, dropTarget: DropTarget): Promise<void> {
    if (moveInFlight) return;

    const request = buildMoveRequest(draggedNodeId, dropTarget);
    clearDropIndicator();
    if (!request) return;

    moveInFlight = true;
    try {
      if (dropTarget.zone === 'into') {
        deps.expandedFolders.add(dropTarget.isVirtualRoot ? null : dropTarget.id);
      }
      selectNodeAndSyncConnectionCheck(draggedNodeId);
      await deps.moveNode(request);
      await refreshTree();
    } catch (error) {
      deps.writeStatus(deps.formatError(error));
    } finally {
      moveInFlight = false;
    }
  }

  function detachPointerDragListeners(): void {
    if (!pointerDragListenersAttached) return;
    pointerDragListenersAttached = false;
    window.removeEventListener('pointermove', onGlobalPointerMove);
    window.removeEventListener('pointerup', onGlobalPointerUp);
    window.removeEventListener('pointercancel', onGlobalPointerCancel);
    window.removeEventListener('blur', onGlobalWindowBlur);
  }

  function attachPointerDragListeners(): void {
    if (pointerDragListenersAttached) return;
    pointerDragListenersAttached = true;
    window.addEventListener('pointermove', onGlobalPointerMove, { passive: false });
    window.addEventListener('pointerup', onGlobalPointerUp, { passive: false });
    window.addEventListener('pointercancel', onGlobalPointerCancel);
    window.addEventListener('blur', onGlobalWindowBlur);
  }

  function resetPointerDragTracking(): void {
    if (pointerDragCandidate) {
      pointerDragCandidate.row.classList.remove('drag-candidate');
    }
    pointerDragCandidate = null;
    pointerDragState = null;
    detachPointerDragListeners();
    setTreeDragCursorActive(false);
    clearDragState();
  }

  function cancelPointerDragTracking(suppressClick: boolean): void {
    const hadActiveDrag = pointerDragState !== null;
    resetPointerDragTracking();
    if (suppressClick && hadActiveDrag) {
      suppressNextClickAfterDrag();
    }
  }

  function beginPointerDragCandidate(
    event: PointerEvent,
    nodeId: string,
    row: HTMLDivElement,
  ): void {
    row.classList.add('drag-candidate');
    pointerDragCandidate = {
      nodeId,
      row,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    pointerDragState = null;
    attachPointerDragListeners();
  }

  function activatePointerDrag(candidate: PointerDragCandidate): void {
    pointerDragCandidate = null;
    candidate.row.classList.remove('drag-candidate');
    pointerDragState = {
      nodeId: candidate.nodeId,
      row: candidate.row,
      pointerId: candidate.pointerId,
      dropTarget: null,
    };
    draggingNodeId = candidate.nodeId;
    draggingRowEl = candidate.row;
    candidate.row.classList.add('dragging');
    setTreeDragCursorActive(true);
  }

  function getTreeRowAtPoint(clientX: number, clientY: number): HTMLDivElement | null {
    const treeEl = deps.getTreeEl();
    if (!treeEl) return null;

    const hit = document.elementFromPoint(clientX, clientY);
    if (!(hit instanceof Element)) return null;

    const row = hit.closest('.tree-row');
    if (!(row instanceof HTMLDivElement)) return null;
    if (!treeEl.contains(row)) return null;
    return row;
  }

  function getDropIndicatorKind(dropTarget: DropTarget): DropIndicatorKind {
    if (dropTarget.zone === 'into' && dropTarget.intoPlacement === 'start') {
      return 'into-start';
    }
    return dropTarget.zone;
  }

  function buildPointerDropTargetForRow(row: HTMLDivElement, clientY: number): DropTarget | null {
    const rowKind = row.dataset.kind;
    if (rowKind !== 'folder' && rowKind !== 'ssh' && rowKind !== 'rdp') {
      return null;
    }

    const id = row.dataset.nodeId ?? null;
    const isVirtualRoot = row.dataset.virtualRoot === 'true';
    const allowInto = rowKind === 'folder' || isVirtualRoot;
    const baseZone = computeDropZone(row, clientY, allowInto);

    if (isVirtualRoot) {
      return {
        id,
        zone: 'into',
        isVirtualRoot: true,
      };
    }

    if (rowKind === 'folder') {
      const isExpanded = row.dataset.expanded === 'true';
      const hasChildren = row.dataset.hasChildren === 'true';

      if (baseZone === 'after' && isExpanded && hasChildren) {
        return {
          id,
          zone: 'into',
          isVirtualRoot: false,
          intoPlacement: 'start',
        };
      }

      if (baseZone === 'into') {
        return {
          id,
          zone: 'into',
          isVirtualRoot: false,
          intoPlacement: 'end',
        };
      }
    }

    return {
      id,
      zone: baseZone,
      isVirtualRoot,
    };
  }

  function updatePointerDragHover(clientX: number, clientY: number): void {
    const dragState = pointerDragState;
    if (!dragState || moveInFlight) {
      clearDropIndicator();
      if (dragState) dragState.dropTarget = null;
      return;
    }

    const row = getTreeRowAtPoint(clientX, clientY);
    if (!row) {
      clearDropIndicator();
      dragState.dropTarget = null;
      return;
    }

    const dropTarget = buildPointerDropTargetForRow(row, clientY);
    if (!dropTarget) {
      clearDropIndicator();
      dragState.dropTarget = null;
      return;
    }
    const request = buildMoveRequest(dragState.nodeId, dropTarget);
    if (!request) {
      clearDropIndicator();
      dragState.dropTarget = null;
      return;
    }

    setDropIndicator(row, getDropIndicatorKind(dropTarget));
    dragState.dropTarget = dropTarget;
  }

  function onGlobalPointerMove(event: PointerEvent): void {
    const candidate = pointerDragCandidate;
    if (candidate && event.pointerId === candidate.pointerId) {
      const dx = event.clientX - candidate.startX;
      const dy = event.clientY - candidate.startY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX) {
        activatePointerDrag(candidate);
      }
    }

    const dragState = pointerDragState;
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    event.preventDefault();
    updatePointerDragHover(event.clientX, event.clientY);
  }

  function onGlobalPointerUp(event: PointerEvent): void {
    const dragState = pointerDragState;
    if (dragState && event.pointerId === dragState.pointerId) {
      event.preventDefault();
      const draggedId = dragState.nodeId;
      const dropTarget = dragState.dropTarget;
      cancelPointerDragTracking(true);
      if (dropTarget && !moveInFlight) {
        void handleDrop(draggedId, dropTarget);
      }
      return;
    }

    const candidate = pointerDragCandidate;
    if (candidate && event.pointerId === candidate.pointerId) {
      cancelPointerDragTracking(false);
    }
  }

  function onGlobalPointerCancel(event: PointerEvent): void {
    const dragState = pointerDragState;
    if (dragState && event.pointerId === dragState.pointerId) {
      cancelPointerDragTracking(true);
      return;
    }

    const candidate = pointerDragCandidate;
    if (candidate && event.pointerId === candidate.pointerId) {
      cancelPointerDragTracking(false);
    }
  }

  function onGlobalWindowBlur(): void {
    cancelPointerDragTracking(pointerDragState !== null);
  }

  function renderTree(): void {
    const treeEl = deps.getTreeEl();
    if (!treeEl) return;

    clearDropIndicator();

    const nodes = deps.getNodes();
    const { byId, byParent } = getTreeIndexes(nodes);

    const searchQuery = deps.getTreeSearchQuery().trim().toLowerCase();
    const isFiltering = searchQuery.length > 0;
    const visibleNodeIds = new Set<string>();
    if (isFiltering) {
      for (const node of nodes) {
        if (!node.name.toLowerCase().includes(searchQuery)) continue;

        visibleNodeIds.add(node.id);

        let parentId = node.parentId;
        while (parentId !== null) {
          visibleNodeIds.add(parentId);
          parentId = byId.get(parentId)?.parentId ?? null;
        }
      }
    }

    const isFolderExpanded = (folderId: string | null): boolean => {
      if (!isFiltering) {
        return deps.expandedFolders.has(folderId);
      }
      return folderId === null || deps.expandedFolders.has(folderId) || visibleNodeIds.has(folderId);
    };

    const isNodeVisible = (nodeId: string): boolean => !isFiltering || visibleNodeIds.has(nodeId);

    const fragment = document.createDocumentFragment();

    const rootRow = createTreeRow({
      id: null,
      label: 'Root',
      kind: 'folder',
      depth: 0,
      isExpanded: isFolderExpanded(null),
      hasChildren: (byParent.get(null) ?? []).length > 0,
      isSelected: deps.getSelectedNodeId() === null,
      isVirtualRoot: true,
      isFiltering,
    });
    fragment.appendChild(rootRow);

    const renderChildren = (parentId: string | null, depth: number): void => {
      if (!isFolderExpanded(parentId)) return;
      const children = byParent.get(parentId) ?? [];

      for (const node of children) {
        if (!isNodeVisible(node.id)) continue;
        const isFolder = node.kind === 'folder';
        const row = createTreeRow({
          id: node.id,
          label: node.name,
          kind: node.kind,
          depth,
          isExpanded: isFolder && isFolderExpanded(node.id),
          hasChildren: isFolder && (byParent.get(node.id) ?? []).length > 0,
          isSelected: deps.getSelectedNodeId() === node.id,
          isVirtualRoot: false,
          isFiltering,
        });
        fragment.appendChild(row);

        if (isFolder) {
          renderChildren(node.id, depth + 1);
        }
      }
    };

    renderChildren(null, 1);
    treeEl.replaceChildren(fragment);
  }

  function createTreeRow(opts: TreeRowOpts): HTMLDivElement {
    const { id, label, kind, depth, isExpanded, hasChildren, isSelected, isVirtualRoot, isFiltering } = opts;
    const isFolder = kind === 'folder';

    const row = document.createElement('div');
    row.className = `tree-row${isSelected ? ' selected' : ''}`;
    row.style.paddingLeft = `${depth * 20 + 8}px`;
    row.dataset.kind = kind;
    row.dataset.virtualRoot = isVirtualRoot ? 'true' : 'false';
    row.dataset.expanded = isExpanded ? 'true' : 'false';
    row.dataset.hasChildren = hasChildren ? 'true' : 'false';
    if (id) row.dataset.nodeId = id;

    const chevron = document.createElement('span');
    chevron.className = `chevron${isExpanded ? ' expanded' : ''}`;
    chevron.innerHTML = isFolder ? '&#9654;' : '';
    row.appendChild(chevron);

    const icon = document.createElement('span');
    icon.className = `tree-icon tree-icon-${kind}`;
    icon.innerHTML = deps.svgIcon(kind);
    row.appendChild(icon);

    const labelEl = document.createElement('span');
    labelEl.className = 'tree-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    row.addEventListener('click', () => {
      if (shouldSuppressClick()) {
        return;
      }

      if (isFolder) {
        const folderId = isVirtualRoot ? null : id;
        if (deps.expandedFolders.has(folderId)) {
          deps.expandedFolders.delete(folderId);
        } else {
          deps.expandedFolders.add(folderId);
        }
      }
      selectNodeAndSyncConnectionCheck(isVirtualRoot ? null : id);
      renderTree();
    });

    if (!isFolder && id) {
      row.addEventListener('dblclick', () => {
        const node = deps.getNodes().find((n) => n.id === id);
        if (!node) return;
        deps.openConnectionNode(node);
      });
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      deps.setSelectedNodeId(isVirtualRoot ? null : id);
      renderTree();

      if (isVirtualRoot) {
        deps.showContextMenu(e.clientX, e.clientY, deps.buildFolderMenuActions(null, true));
      } else if (id) {
        const node = deps.getNodes().find((n) => n.id === id);
        if (!node) return;
        if (node.kind === 'folder') {
          deps.showContextMenu(e.clientX, e.clientY, deps.buildFolderMenuActions(node, false));
        } else {
          deps.showContextMenu(e.clientX, e.clientY, deps.buildConnectionMenuActions(node));
        }
      }
    });

    if (!isFiltering && !isVirtualRoot) {
      // Drag-and-drop is intentionally disabled while filtering to avoid ambiguous placement.
      row.classList.add('movable');
      row.addEventListener('pointerdown', (event) => {
        if (!id || moveInFlight || event.button !== 0) return;
        beginPointerDragCandidate(event, id, row);
      });
    }

    return row;
  }

  return {
    refreshTree,
    renderTree,
  };
}
