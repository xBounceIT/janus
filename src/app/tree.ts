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
  getNodes: () => ConnectionNode[];
  setNodes: (nodes: ConnectionNode[]) => void;
  expandedFolders: Set<string | null>;
  getSelectedNodeId: () => string | null;
  setSelectedNodeId: (id: string | null) => void;
  bumpPingRequestSeq: () => void;
  clearPingStatus: () => void;
  pingSelectedConnection: (nodeId: string, connectionName: string) => Promise<void>;
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
    for (const node of nodes) {
      const arr = byParent.get(node.parentId) ?? [];
      arr.push(node);
      byParent.set(node.parentId, arr);
    }

    const fragment = document.createDocumentFragment();

    const rootRow = createTreeRow({
      id: null,
      label: 'Root',
      kind: 'folder',
      depth: 0,
      isExpanded: deps.expandedFolders.has(null),
      isSelected: deps.getSelectedNodeId() === null,
      isVirtualRoot: true,
    });
    fragment.appendChild(rootRow);

    const renderChildren = (parentId: string | null, depth: number): void => {
      if (!deps.expandedFolders.has(parentId)) return;
      const children = byParent.get(parentId) ?? [];
      children.sort((a, b) => a.orderIndex - b.orderIndex);

      for (const node of children) {
        const isFolder = node.kind === 'folder';
        const row = createTreeRow({
          id: node.id,
          label: node.name,
          kind: node.kind,
          depth,
          isExpanded: isFolder && deps.expandedFolders.has(node.id),
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
        deps.bumpPingRequestSeq();
        deps.clearPingStatus();
        return;
      }

      const node = deps.getNodes().find((n) => n.id === id);
      if (!node || (node.kind !== 'ssh' && node.kind !== 'rdp')) {
        deps.bumpPingRequestSeq();
        deps.clearPingStatus();
        return;
      }

      void deps.pingSelectedConnection(node.id, node.name);
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
