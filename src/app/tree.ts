import type { ConnectionNode, NodeKind } from '../types';
import type { MenuAction } from './context-menu';

type TreeRowOpts = {
  id: string | null;
  label: string;
  kind: NodeKind;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isVirtualRoot: boolean;
};

export type TreeControllerDeps = {
  listTree: () => Promise<ConnectionNode[]>;
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
};

export type TreeController = {
  refreshTree: () => Promise<void>;
  renderTree: () => void;
};

export function createTreeController(deps: TreeControllerDeps): TreeController {
  async function refreshTree(): Promise<void> {
    deps.setNodes(await deps.listTree());
    renderTree();
  }

  function renderTree(): void {
    const treeEl = deps.getTreeEl();
    if (!treeEl) return;

    const nodes = deps.getNodes();
    const byParent = new Map<string | null, ConnectionNode[]>();
    const byId = new Map<string, ConnectionNode>();
    for (const node of nodes) {
      byId.set(node.id, node);
      const arr = byParent.get(node.parentId) ?? [];
      arr.push(node);
      byParent.set(node.parentId, arr);
    }

    const searchQuery = deps.getTreeSearchQuery().trim().toLowerCase();
    const isFiltering = searchQuery.length > 0;
    const visibleNodeIds = new Set<string>();
    const forcedExpandedFolders = new Set<string | null>();

    if (isFiltering) {
      forcedExpandedFolders.add(null);
      for (const node of nodes) {
        if (!node.name.toLowerCase().includes(searchQuery)) continue;

        visibleNodeIds.add(node.id);

        let parentId = node.parentId;
        while (parentId !== null) {
          visibleNodeIds.add(parentId);
          forcedExpandedFolders.add(parentId);
          parentId = byId.get(parentId)?.parentId ?? null;
        }
      }
    }

    const isFolderExpanded = (folderId: string | null): boolean => {
      if (!isFiltering) {
        return deps.expandedFolders.has(folderId);
      }
      return folderId === null || forcedExpandedFolders.has(folderId) || deps.expandedFolders.has(folderId);
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
    });
    fragment.appendChild(rootRow);

    const renderChildren = (parentId: string | null, depth: number): void => {
      if (!isFolderExpanded(parentId)) return;
      const children = byParent.get(parentId) ?? [];
      children.sort((a, b) => a.orderIndex - b.orderIndex);

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
    const { id, label, kind, depth, isExpanded, isSelected, isVirtualRoot } = opts;
    const isFolder = kind === 'folder';

    const row = document.createElement('div');
    row.className = `tree-row${isSelected ? ' selected' : ''}`;
    row.style.paddingLeft = `${depth * 20 + 8}px`;

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

    return row;
  }

  return {
    refreshTree,
    renderTree,
  };
}
