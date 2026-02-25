import type { ConnectionNode, NodeKind, NodeMoveRequest } from '../types';
import type { MenuAction } from './context-menu';

type DropZone = 'before' | 'after' | 'into';

type DropTarget = {
  id: string | null;
  zone: DropZone;
  isVirtualRoot: boolean;
};

type TreeIndexes = {
  byId: Map<string, ConnectionNode>;
  byParent: Map<string | null, ConnectionNode[]>;
};

type TreeRowOpts = {
  id: string | null;
  label: string;
  kind: NodeKind;
  depth: number;
  isExpanded: boolean;
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
  let draggingNodeId: string | null = null;
  let draggingRowEl: HTMLDivElement | null = null;
  let activeDropIndicator: { row: HTMLDivElement; zone: DropZone } | null = null;
  let moveInFlight = false;

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

  function clearDropIndicator(): void {
    if (!activeDropIndicator) return;
    activeDropIndicator.row.classList.remove('drop-before', 'drop-after', 'drop-into');
    activeDropIndicator = null;
  }

  function setDropIndicator(row: HTMLDivElement, zone: DropZone): void {
    if (activeDropIndicator?.row === row && activeDropIndicator.zone === zone) {
      return;
    }

    clearDropIndicator();
    row.classList.add(`drop-${zone}`);
    activeDropIndicator = { row, zone };
  }

  function clearDragState(): void {
    draggingNodeId = null;
    if (draggingRowEl) {
      draggingRowEl.classList.remove('dragging');
    }
    draggingRowEl = null;
    clearDropIndicator();
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
    const { byId, byParent } = buildTreeIndexes(nodes);
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
      newIndex = targetChildren.length;
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
      deps.setSelectedNodeId(draggedNodeId);
      await deps.moveNode(request);
      await refreshTree();
    } catch (error) {
      deps.writeStatus(deps.formatError(error));
    } finally {
      moveInFlight = false;
    }
  }

  function renderTree(): void {
    const treeEl = deps.getTreeEl();
    if (!treeEl) return;

    clearDropIndicator();

    const nodes = deps.getNodes();
    const { byId, byParent } = buildTreeIndexes(nodes);

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
    const { id, label, kind, depth, isExpanded, isSelected, isVirtualRoot, isFiltering } = opts;
    const isFolder = kind === 'folder';

    const row = document.createElement('div');
    row.className = `tree-row${isSelected ? ' selected' : ''}`;
    row.style.paddingLeft = `${depth * 20 + 8}px`;
    row.dataset.kind = kind;
    row.dataset.virtualRoot = isVirtualRoot ? 'true' : 'false';
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
      if (isFolder) {
        const folderId = isVirtualRoot ? null : id;
        if (deps.expandedFolders.has(folderId)) {
          deps.expandedFolders.delete(folderId);
        } else {
          deps.expandedFolders.add(folderId);
        }
      }
      deps.setSelectedNodeId(isVirtualRoot ? null : id);
      renderTree();

      if (isFolder || !id) {
        deps.bumpConnectionCheckRequestSeq();
        deps.clearConnectionCheckStatus();
        return;
      }

      const node = deps.getNodes().find((n) => n.id === id);
      if (!node || (node.kind !== 'ssh' && node.kind !== 'rdp')) {
        deps.bumpConnectionCheckRequestSeq();
        deps.clearConnectionCheckStatus();
        return;
      }

      void deps.checkSelectedConnection(node.id, node.name);
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
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        if (!id || moveInFlight) {
          event.preventDefault();
          return;
        }

        draggingNodeId = id;
        draggingRowEl = row;
        row.classList.add('dragging');

        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', id);
        }
      });

      row.addEventListener('dragend', () => {
        clearDragState();
      });
    }

    if (!isFiltering) {
      row.addEventListener('dragover', (event) => {
        if (!draggingNodeId || moveInFlight) return;

        const zone = computeDropZone(row, event.clientY, isFolder || isVirtualRoot);
        const dropTarget: DropTarget = {
          id,
          zone,
          isVirtualRoot,
        };
        const effectiveZone: DropZone = isVirtualRoot ? 'into' : zone;
        const request = buildMoveRequest(draggingNodeId, {
          ...dropTarget,
          zone: effectiveZone,
        });
        if (!request) {
          clearDropIndicator();
          return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
        setDropIndicator(row, effectiveZone);
      });

      row.addEventListener('drop', (event) => {
        if (!draggingNodeId || moveInFlight) return;

        const zone = computeDropZone(row, event.clientY, isFolder || isVirtualRoot);
        const dropTarget: DropTarget = {
          id,
          zone: isVirtualRoot ? 'into' : zone,
          isVirtualRoot,
        };

        const request = buildMoveRequest(draggingNodeId, dropTarget);
        if (!request) {
          clearDropIndicator();
          return;
        }

        event.preventDefault();
        const draggedId = draggingNodeId;
        clearDragState();
        void handleDrop(draggedId, dropTarget);
      });
    }

    return row;
  }

  return {
    refreshTree,
    renderTree,
  };
}
