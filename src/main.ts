import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { FitAddon } from '@xterm/addon-fit';
import cargoToml from '../src-tauri/Cargo.toml?raw';
import { Terminal } from '@xterm/xterm';
import { api } from './api';
import type { ConnectionNode, ConnectionUpsert, NodeKind, SshHostKeyMismatchResult } from './types';

/* ── Types ────────────────────────────────────────── */

type SshSessionTab = {
  kind: 'ssh';
  sessionId: string;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  cleanup: Array<() => void>;
};

type RdpSessionTab = {
  kind: 'rdp';
  sessionId: string;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cleanup: Array<() => void>;
};

type SessionTab = SshSessionTab | RdpSessionTab;

/* ── DOM refs ─────────────────────────────────────── */

const app = must<HTMLDivElement>('#app');

let statusEl: HTMLElement | null = null;
let treeEl: HTMLDivElement | null = null;
let tabsEl: HTMLDivElement | null = null;
let workspaceEl: HTMLDivElement | null = null;
let appShellEl: HTMLDivElement | null = null;
let unlockOverlayEl: HTMLDivElement | null = null;
let unlockInputEl: HTMLInputElement | null = null;
let unlockStatusEl: HTMLElement | null = null;
let contextMenuEl: HTMLDivElement | null = null;
let modalOverlayEl: HTMLDivElement | null = null;
let fileMenuTriggerEl: HTMLButtonElement | null = null;
let fileMenuEl: HTMLDivElement | null = null;
let vaultLockEl: HTMLButtonElement | null = null;
let appVersionEl: HTMLSpanElement | null = null;
let vaultUnlocked = false;
let fileMenuOpen = false;
let nativeContextMenuSuppressed = false;
const APP_VERSION = parseCargoPackageVersion(cargoToml);

/* ── Session state ────────────────────────────────── */

const tabs = new Map<string, SessionTab>();
let nodes: ConnectionNode[] = [];
let activeTab: string | null = null;
let workspaceResizeObserver: ResizeObserver | null = null;
let pendingTabResizeFrame: number | null = null;

/* ── Tree state ───────────────────────────────────── */

const expandedFolders = new Set<string | null>([null]);
let selectedNodeId: string | null = null;

/* ── Boot ─────────────────────────────────────────── */

void api.listenErrors((message) => writeStatus(message));

window.addEventListener('resize', () => {
  scheduleActiveTabResize();
});

void boot();

async function boot(): Promise<void> {
  renderLoading();

  try {
    const status = await api.vaultStatus();
    if (!status.initialized) {
      renderSetupWizard();
      return;
    }

    renderMainApp(status.unlocked);
  } catch (error) {
    renderStartupError(formatError(error));
  }
}

/* ── Loading / Error / Setup ──────────────────────── */

function renderLoading(): void {
  app.innerHTML = `
    <div class="setup-shell">
      <section class="setup-card">
        <h1>Janus</h1>
        <p class="setup-copy">Checking vault status...</p>
        <p id="setup-status" class="setup-status"></p>
      </section>
    </div>
  `;

  statusEl = must<HTMLElement>('#setup-status');
  resetMainShellState();
}

function renderStartupError(message: string): void {
  app.innerHTML = `
    <div class="setup-shell">
      <section class="setup-card">
        <h1>Janus</h1>
        <p class="setup-copy">The app could not read vault status.</p>
        <p id="setup-status" class="setup-status">${escapeHtml(message)}</p>
        <div class="setup-actions">
          <button class="btn btn-primary" id="setup-retry">Retry</button>
        </div>
      </section>
    </div>
  `;

  statusEl = must<HTMLElement>('#setup-status');
  resetMainShellState();

  must<HTMLButtonElement>('#setup-retry').addEventListener('click', () => {
    void boot();
  });
}

function renderSetupWizard(): void {
  app.innerHTML = `
    <div class="setup-shell">
      <section class="setup-card">
        <h1>Welcome to Janus</h1>
        <p class="setup-copy">Create a master passphrase to initialize your encrypted local vault.</p>
        <div id="setup-content"></div>
        <p id="setup-status" class="setup-status"></p>
      </section>
    </div>
  `;

  statusEl = must<HTMLElement>('#setup-status');
  resetMainShellState();

  const contentEl = must<HTMLDivElement>('#setup-content');
  let step: 1 | 2 = 1;
  let busy = false;

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    const back = contentEl.querySelector<HTMLButtonElement>('#setup-back');
    const init = contentEl.querySelector<HTMLButtonElement>('#setup-init');

    if (back) {
      back.disabled = nextBusy;
    }

    if (init) {
      init.disabled = nextBusy;
      init.textContent = nextBusy ? 'Initializing...' : 'Initialize vault';
    }
  };

  const renderStep = (): void => {
    writeStatus('');

    if (step === 1) {
      contentEl.innerHTML = `
        <div class="setup-step">
          <h2>Step 1 of 2</h2>
          <p>Your passphrase protects stored credentials for SSH and RDP connections.</p>
          <p>Janus encrypts vault data locally and never uploads it.</p>
          <div class="setup-actions">
            <button class="btn btn-primary" id="setup-next">Continue</button>
          </div>
        </div>
      `;

      must<HTMLButtonElement>('#setup-next').addEventListener('click', () => {
        step = 2;
        renderStep();
      });
      applyInputPrivacyAttributes(contentEl);
      return;
    }

    contentEl.innerHTML = `
      <div class="setup-step">
        <h2>Step 2 of 2</h2>
        <div class="form-field">
          <input id="setup-passphrase" type="password" placeholder="Master passphrase" />
        </div>
        <div class="form-field">
          <input id="setup-passphrase-confirm" type="password" placeholder="Confirm passphrase" />
        </div>
        <div class="setup-actions">
          <button class="btn" id="setup-back">Back</button>
          <button class="btn btn-primary" id="setup-init">Initialize vault</button>
        </div>
      </div>
    `;

    must<HTMLButtonElement>('#setup-back').addEventListener('click', () => {
      if (busy) return;
      step = 1;
      renderStep();
    });

    must<HTMLButtonElement>('#setup-init').addEventListener('click', async () => {
      if (busy) return;

      const passphraseEl = must<HTMLInputElement>('#setup-passphrase');
      const confirmEl = must<HTMLInputElement>('#setup-passphrase-confirm');

      const passphrase = passphraseEl.value.trim();
      const confirm = confirmEl.value.trim();

      if (!passphrase) {
        writeStatus('Passphrase cannot be empty');
        return;
      }

      if (passphrase !== confirm) {
        writeStatus('Passphrases do not match');
        return;
      }

      setBusy(true);

      try {
        await api.vaultInitialize(passphrase);
        await api.vaultUnlock(passphrase);

        passphraseEl.value = '';
        confirmEl.value = '';

        renderMainApp(true);
        return;
      } catch (error) {
        const message = formatError(error);
        writeStatus(message);
        passphraseEl.value = '';
        confirmEl.value = '';

        if (message.includes('vault already initialized')) {
          void boot();
          return;
        }
      }

      setBusy(false);
    });

    setBusy(false);
    applyInputPrivacyAttributes(contentEl);
  };

  renderStep();
}

/* ── Main App ─────────────────────────────────────── */

function renderMainApp(initiallyUnlocked: boolean): void {
  app.innerHTML = `
    <div id="app-shell" class="app-shell">
      <div class="app-toolbar">
        <div class="menu-root">
          <button class="menu-trigger" id="file-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu">File</button>
          <div id="file-menu" class="menu-panel" role="menu" aria-hidden="true">
            <button class="menu-item" id="file-import" role="menuitem">Import</button>
            <button class="menu-item" id="file-export" role="menuitem">Export</button>
          </div>
        </div>
        <div class="toolbar-spacer"></div>
        <button class="btn btn-sm icon-btn" id="vault-lock" aria-label="Lock vault" title="Lock vault"></button>
      </div>
      <div class="app-layout">
        <aside class="sidebar">
          <div class="sidebar-header">Connections</div>
          <div id="tree" class="tree-container"></div>
        </aside>
        <div class="sidebar-resizer" id="sidebar-resizer"></div>
        <main class="main-area">
          <div id="tabs" class="tab-bar"></div>
          <div id="workspace" class="workspace"></div>
        </main>
      </div>
      <div class="status-bar">
        <span id="status"></span>
        <span id="app-version" class="app-version"></span>
      </div>
    </div>
    <div id="unlock-overlay" class="unlock-overlay" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="unlock-title">
      <section class="unlock-modal">
        <h2 id="unlock-title">Unlock Vault</h2>
        <p class="unlock-copy">Enter your master passphrase to unlock local credentials.</p>
        <div class="form-field">
          <input id="unlock-passphrase" type="password" placeholder="Master passphrase" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="unlock-submit">Unlock</button>
        </div>
        <p id="unlock-status" class="unlock-status"></p>
      </section>
    </div>
    <div id="context-menu" class="context-menu"></div>
    <div id="modal-overlay" class="modal-overlay"></div>
  `;

  statusEl = must<HTMLSpanElement>('#status');
  treeEl = must<HTMLDivElement>('#tree');
  tabsEl = must<HTMLDivElement>('#tabs');
  workspaceEl = must<HTMLDivElement>('#workspace');
  appShellEl = must<HTMLDivElement>('#app-shell');
  unlockOverlayEl = must<HTMLDivElement>('#unlock-overlay');
  unlockInputEl = must<HTMLInputElement>('#unlock-passphrase');
  unlockStatusEl = must<HTMLElement>('#unlock-status');
  contextMenuEl = must<HTMLDivElement>('#context-menu');
  modalOverlayEl = must<HTMLDivElement>('#modal-overlay');
  fileMenuTriggerEl = must<HTMLButtonElement>('#file-menu-trigger');
  fileMenuEl = must<HTMLDivElement>('#file-menu');
  vaultLockEl = must<HTMLButtonElement>('#vault-lock');
  appVersionEl = must<HTMLSpanElement>('#app-version');

  tabs.clear();
  nodes = [];
  activeTab = null;
  selectedNodeId = null;
  expandedFolders.clear();
  expandedFolders.add(null);

  wireToolbar();
  wireUnlockModal();
  wireSidebarResizer();
  wireWorkspaceResizeObserver();
  wireGlobalKeyboard();
  wireGlobalContextMenuSuppression();
  wireContextMenuDismiss();
  applyInputPrivacyAttributes(app);
  void loadAppVersion();
  void refreshTree();

  if (initiallyUnlocked) {
    hideUnlockModal();
    return;
  }

  showUnlockModal();
  writeStatus('Vault is locked');
}

/* ── Toolbar ──────────────────────────────────────── */

function wireToolbar(): void {
  must<HTMLButtonElement>('#vault-lock').addEventListener('click', async () => {
    if (!vaultUnlocked) return;

    try {
      await api.vaultLock();
      showUnlockModal();
      writeStatus('Vault locked');
    } catch (error) {
      writeStatus(formatError(error));
    }
  });

  must<HTMLButtonElement>('#file-menu-trigger').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFileMenu();
  });

  must<HTMLButtonElement>('#file-import').addEventListener('click', () => {
    setFileMenuOpen(false);
    showImportModal();
  });

  must<HTMLButtonElement>('#file-export').addEventListener('click', () => {
    setFileMenuOpen(false);
    showExportModal();
  });

  document.addEventListener('click', (event) => {
    if (!fileMenuOpen) return;
    const target = event.target as Node;
    if (fileMenuEl?.contains(target) || fileMenuTriggerEl?.contains(target)) {
      return;
    }
    setFileMenuOpen(false);
  });
}

/* ── Unlock Modal ─────────────────────────────────── */

function wireUnlockModal(): void {
  const submitEl = must<HTMLButtonElement>('#unlock-submit');
  const passphraseEl = must<HTMLInputElement>('#unlock-passphrase');
  const modalStatusEl = must<HTMLElement>('#unlock-status');
  let busy = false;

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    submitEl.disabled = nextBusy;
    passphraseEl.disabled = nextBusy;
    submitEl.textContent = nextBusy ? 'Unlocking...' : 'Unlock';
  };

  const unlock = async (): Promise<void> => {
    if (busy) return;

    const passphrase = passphraseEl.value.trim();
    if (!passphrase) {
      modalStatusEl.textContent = 'Passphrase cannot be empty';
      passphraseEl.focus();
      return;
    }

    setBusy(true);
    modalStatusEl.textContent = '';

    try {
      await api.vaultUnlock(passphrase);
      hideUnlockModal();
      writeStatus('Vault unlocked');
    } catch (error) {
      modalStatusEl.textContent = formatError(error);
      passphraseEl.focus();
      passphraseEl.select();
    } finally {
      setBusy(false);
    }
  };

  submitEl.addEventListener('click', () => {
    void unlock();
  });

  passphraseEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void unlock();
  });

  setBusy(false);
}

function showUnlockModal(message = ''): void {
  setVaultUnlocked(false);
  if (unlockStatusEl) {
    unlockStatusEl.textContent = message;
  }
  if (unlockInputEl) {
    unlockInputEl.value = '';
    window.setTimeout(() => unlockInputEl?.focus(), 0);
  }
}

function hideUnlockModal(): void {
  setVaultUnlocked(true);
  if (unlockStatusEl) {
    unlockStatusEl.textContent = '';
  }
  if (unlockInputEl) {
    unlockInputEl.value = '';
  }
}

function setVaultUnlocked(unlocked: boolean): void {
  vaultUnlocked = unlocked;
  if (!vaultUnlocked) {
    setFileMenuOpen(false);
  }
  if (appShellEl) {
    appShellEl.classList.toggle('locked', !vaultUnlocked);
  }
  if (unlockOverlayEl) {
    unlockOverlayEl.classList.toggle('visible', !vaultUnlocked);
    unlockOverlayEl.setAttribute('aria-hidden', vaultUnlocked ? 'true' : 'false');
  }
  updateVaultLockState();
}

/* ── Sidebar Resizer ──────────────────────────────── */

function wireSidebarResizer(): void {
  const resizer = must<HTMLDivElement>('#sidebar-resizer');
  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');

    const onMove = (ev: MouseEvent): void => {
      if (!dragging) return;
      const width = Math.min(500, Math.max(180, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      scheduleActiveTabResize();
    };

    const onUp = (): void => {
      dragging = false;
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      scheduleActiveTabResize();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function wireWorkspaceResizeObserver(): void {
  workspaceResizeObserver?.disconnect();
  if (!workspaceEl) return;

  workspaceResizeObserver = new ResizeObserver(() => {
    scheduleActiveTabResize();
  });
  workspaceResizeObserver.observe(workspaceEl);
}

/* ── Global Keyboard ──────────────────────────────── */

function wireGlobalKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (fileMenuOpen) {
        setFileMenuOpen(false);
        return;
      }
      if (contextMenuEl?.classList.contains('visible')) {
        hideContextMenu();
        return;
      }
      if (modalOverlayEl?.classList.contains('visible')) {
        hideModal();
      }
    }
  });
}

function wireGlobalContextMenuSuppression(): void {
  if (nativeContextMenuSuppressed) return;

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  nativeContextMenuSuppressed = true;
}

/* ── Tree ─────────────────────────────────────────── */

async function refreshTree(): Promise<void> {
  nodes = await api.listTree();
  renderTree();
}

function renderTree(): void {
  if (!treeEl) return;

  const byParent = new Map<string | null, ConnectionNode[]>();
  for (const node of nodes) {
    const arr = byParent.get(node.parentId) ?? [];
    arr.push(node);
    byParent.set(node.parentId, arr);
  }

  const fragment = document.createDocumentFragment();

  // Virtual Root row
  const rootRow = createTreeRow({
    id: null,
    label: 'Root',
    kind: 'folder',
    depth: 0,
    isExpanded: expandedFolders.has(null),
    isSelected: selectedNodeId === null,
    isVirtualRoot: true
  });
  fragment.appendChild(rootRow);

  // Render children recursively (flat divs)
  const renderChildren = (parentId: string | null, depth: number): void => {
    if (!expandedFolders.has(parentId)) return;
    const children = byParent.get(parentId) ?? [];
    children.sort((a, b) => a.orderIndex - b.orderIndex);

    for (const node of children) {
      const isFolder = node.kind === 'folder';
      const row = createTreeRow({
        id: node.id,
        label: node.name,
        kind: node.kind,
        depth,
        isExpanded: isFolder && expandedFolders.has(node.id),
        isSelected: selectedNodeId === node.id,
        isVirtualRoot: false
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

type TreeRowOpts = {
  id: string | null;
  label: string;
  kind: NodeKind;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isVirtualRoot: boolean;
};

function createTreeRow(opts: TreeRowOpts): HTMLDivElement {
  const { id, label, kind, depth, isExpanded, isSelected, isVirtualRoot } = opts;
  const isFolder = kind === 'folder';

  const row = document.createElement('div');
  row.className = `tree-row${isSelected ? ' selected' : ''}`;
  row.style.paddingLeft = `${depth * 20 + 8}px`;

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = `chevron${isExpanded ? ' expanded' : ''}`;
  chevron.innerHTML = isFolder ? '&#9654;' : '';
  row.appendChild(chevron);

  // Icon
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = svgIcon(kind);
  row.appendChild(icon);

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  // Click handler
  row.addEventListener('click', () => {
    if (isFolder) {
      const folderId = isVirtualRoot ? null : id;
      if (expandedFolders.has(folderId)) {
        expandedFolders.delete(folderId);
      } else {
        expandedFolders.add(folderId);
      }
    }
    selectedNodeId = isVirtualRoot ? null : id;
    renderTree();
  });

  // Double-click: open connection
  if (!isFolder && id) {
    row.addEventListener('dblclick', () => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      if (node.kind === 'ssh') {
        void openSshWithStatus(node);
      } else if (node.kind === 'rdp') {
        void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
      }
    });
  }

  // Right-click: context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectedNodeId = isVirtualRoot ? null : id;
    renderTree();

    if (isVirtualRoot) {
      showContextMenu(e.clientX, e.clientY, buildFolderMenuActions(null, true));
    } else if (id) {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      if (node.kind === 'folder') {
        showContextMenu(e.clientX, e.clientY, buildFolderMenuActions(node, false));
      } else {
        showContextMenu(e.clientX, e.clientY, buildConnectionMenuActions(node));
      }
    }
  });

  return row;
}

/* ── SVG Icons ────────────────────────────────────── */

function svgIcon(kind: NodeKind): string {
  if (kind === 'folder') {
    return `<svg viewBox="0 0 16 16" fill="var(--folder-icon)"><path d="M1.5 2A1.5 1.5 0 003 3.5h3.09a1 1 0 01.7.29l.71.71H13a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0113 14.5H3A1.5 1.5 0 011.5 13V2z" fill="none" stroke="var(--folder-icon)" stroke-width="1.2"/><path d="M1.5 5h13v8a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 13V5z"/></svg>`;
  }
  if (kind === 'ssh') {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="var(--ssh-icon)" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="4" y1="6" x2="7" y2="6"/><line x1="4" y1="8" x2="9" y2="8"/><line x1="4" y1="10" x2="6" y2="10"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" fill="none" stroke="var(--rdp-icon)" stroke-width="1.3"><rect x="1.5" y="1.5" width="13" height="10" rx="1.5"/><line x1="5" y1="13.5" x2="11" y2="13.5"/><line x1="8" y1="11.5" x2="8" y2="13.5"/></svg>`;
}

/* ── Context Menu ─────────────────────────────────── */

type MenuAction = { label: string; danger?: boolean; action: () => void } | 'separator';

function buildFolderMenuActions(node: ConnectionNode | null, isRoot: boolean): MenuAction[] {
  const parentId = isRoot ? null : node?.id ?? null;
  const items: MenuAction[] = [
    { label: 'New Folder', action: () => showFolderModal(parentId) },
    { label: 'New connection', action: () => showConnectionModal('ssh', parentId) }
  ];

  if (!isRoot && node) {
    items.push('separator');
    items.push({ label: 'Rename', action: () => showRenameModal(node) });
    items.push({ label: 'Delete', danger: true, action: () => showDeleteModal(node) });
  }

  return items;
}

function buildConnectionMenuActions(node: ConnectionNode): MenuAction[] {
  const items: MenuAction[] = [];

  if (node.kind === 'ssh') {
    items.push({
      label: 'Open SSH',
      action: () => {
        void openSshWithStatus(node);
      }
    });
  } else if (node.kind === 'rdp') {
    items.push({
      label: 'Open RDP',
      action: () => {
        void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
      }
    });
  }

  items.push('separator');
  items.push({ label: 'Edit', action: () => showEditConnectionModal(node) });
  items.push({ label: 'Rename', action: () => showRenameModal(node) });
  items.push('separator');
  items.push({ label: 'Delete', danger: true, action: () => showDeleteModal(node) });

  return items;
}

function showContextMenu(x: number, y: number, actions: MenuAction[]): void {
  if (!contextMenuEl) return;

  contextMenuEl.replaceChildren();

  for (const action of actions) {
    if (action === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      contextMenuEl.appendChild(sep);
      continue;
    }

    const item = document.createElement('div');
    item.className = `context-menu-item${action.danger ? ' danger' : ''}`;
    item.textContent = action.label;
    item.addEventListener('click', () => {
      hideContextMenu();
      action.action();
    });
    contextMenuEl.appendChild(item);
  }

  // Position clamped to viewport
  contextMenuEl.style.left = '0';
  contextMenuEl.style.top = '0';
  contextMenuEl.classList.add('visible');

  const rect = contextMenuEl.getBoundingClientRect();
  const clampedX = Math.min(x, window.innerWidth - rect.width - 4);
  const clampedY = Math.min(y, window.innerHeight - rect.height - 4);
  contextMenuEl.style.left = `${Math.max(0, clampedX)}px`;
  contextMenuEl.style.top = `${Math.max(0, clampedY)}px`;
}

function hideContextMenu(): void {
  contextMenuEl?.classList.remove('visible');
}

function wireContextMenuDismiss(): void {
  document.addEventListener('click', (e) => {
    if (contextMenuEl?.classList.contains('visible')) {
      if (!contextMenuEl.contains(e.target as Node)) {
        hideContextMenu();
      }
    }
  });
}

/* ── Modal System ─────────────────────────────────── */

function showModal(title: string, buildContent: (card: HTMLDivElement) => void): void {
  if (!modalOverlayEl) return;

  const card = document.createElement('div');
  card.className = 'modal-card';

  const h2 = document.createElement('h2');
  h2.textContent = title;
  card.appendChild(h2);

  buildContent(card);
  applyInputPrivacyAttributes(card);

  modalOverlayEl.replaceChildren(card);
  modalOverlayEl.classList.add('visible');

  // Focus first input
  const firstInput = card.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
  if (firstInput) {
    window.setTimeout(() => firstInput.focus(), 0);
  }

  // Click backdrop to close
  modalOverlayEl.addEventListener(
    'click',
    (e) => {
      if (e.target === modalOverlayEl) {
        hideModal();
      }
    },
    { once: true }
  );
}

function hideModal(): void {
  modalOverlayEl?.classList.remove('visible');
}

/* ── Folder Modal ─────────────────────────────────── */

function showFolderModal(parentId: string | null): void {
  showModal('New Folder', (card) => {
    card.innerHTML += `
      <div class="form-field">
        <label>Name</label>
        <input id="modal-folder-name" type="text" placeholder="Folder name" />
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-confirm">Create</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const name = (card.querySelector('#modal-folder-name') as HTMLInputElement).value.trim();
      if (!name) return;

      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Creating...';

      try {
        await api.upsertFolder({
          id: crypto.randomUUID(),
          parentId,
          name,
          orderIndex: Date.now()
        });
        if (parentId) expandedFolders.add(parentId);
        hideModal();
        await refreshTree();
        writeStatus('Folder created');
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = 'Create';
      }
    });

    wireModalEnterKey(card, '#modal-confirm');
  });
}

/* ── Connection Modal (New / Edit) ────────────────── */

function showConnectionModal(
  protocol: 'ssh' | 'rdp',
  parentId: string | null,
  existing?: ConnectionNode
): void {
  const isEdit = !!existing;
  const title = isEdit ? `Edit ${existing!.name}` : 'New Connection';

  showModal(title, (card) => {
    const activeProtocol = isEdit ? existing!.kind as 'ssh' | 'rdp' : protocol;

    // Name field
    card.innerHTML += `
      <div class="form-field">
        <label>Name</label>
        <input id="modal-conn-name" type="text" placeholder="Display name" value="${escapeAttr(existing?.name ?? '')}" />
      </div>
    `;

    // Protocol tabs
    const tabsDiv = document.createElement('div');
    tabsDiv.className = 'protocol-tabs';
    tabsDiv.innerHTML = `
      <button class="protocol-tab${activeProtocol === 'ssh' ? ' active' : ''}" data-proto="ssh" ${isEdit ? 'disabled' : ''}>SSH</button>
      <button class="protocol-tab${activeProtocol === 'rdp' ? ' active' : ''}" data-proto="rdp" ${isEdit ? 'disabled' : ''}>RDP</button>
    `;
    card.appendChild(tabsDiv);

    // Protocol fields container
    const fieldsDiv = document.createElement('div');
    fieldsDiv.id = 'modal-proto-fields';
    card.appendChild(fieldsDiv);

    let currentProto = activeProtocol;
    let hasSubmitAttemptedValidation = false;
    let clearValidationListeners: Array<() => void> = [];

    const renderProtoFields = (): void => {
      if (currentProto === 'ssh') {
        renderSshFields(fieldsDiv, isEdit ? existing : null);
      } else {
        renderRdpFields(fieldsDiv, isEdit ? existing : null);
      }
      applyInputPrivacyAttributes(fieldsDiv);
    };

    const refreshValidationListeners = (): void => {
      for (const clear of clearValidationListeners) {
        clear();
      }
      clearValidationListeners = [];

      for (const rule of getRequiredConnectionFieldRules(currentProto)) {
        const input = card.querySelector<HTMLInputElement>(rule.selector);
        if (!input) continue;

        const onInput = (): void => {
          if (!hasSubmitAttemptedValidation) return;

          if (input.value.trim()) {
            clearFieldInvalid(input);
          } else {
            setFieldInvalid(input, rule.message);
          }

          if (!findFirstMissingRequiredField(card, currentProto)) {
            writeStatus('');
          }
        };

        input.addEventListener('input', onInput);
        clearValidationListeners.push(() => input.removeEventListener('input', onInput));
      }
    };

    renderProtoFields();
    refreshValidationListeners();

    // Protocol tab switching (only in create mode)
    if (!isEdit) {
      for (const btn of tabsDiv.querySelectorAll<HTMLButtonElement>('.protocol-tab')) {
        btn.addEventListener('click', () => {
          currentProto = btn.dataset.proto as 'ssh' | 'rdp';
          for (const b of tabsDiv.querySelectorAll('.protocol-tab')) b.classList.remove('active');
          btn.classList.add('active');
          clearModalValidation(card);
          if (hasSubmitAttemptedValidation) {
            writeStatus('');
          }
          renderProtoFields();
          refreshValidationListeners();
        });
      }
    }

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.id = 'modal-cancel';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary';
    confirmBtn.id = 'modal-confirm';
    confirmBtn.textContent = isEdit ? 'Save' : 'Create';

    actionsDiv.append(cancelBtn, confirmBtn);
    card.appendChild(actionsDiv);

    cancelBtn.addEventListener('click', hideModal);
    confirmBtn.addEventListener('click', async () => {
      clearModalValidation(card);
      const validation = validateConnectionRequiredFields(card, currentProto);
      if (!validation.ok) {
        hasSubmitAttemptedValidation = true;
        writeStatus(validation.statusMessage);
        validation.firstInvalid?.focus();
        return;
      }
      hasSubmitAttemptedValidation = false;

      const name = (card.querySelector('#modal-conn-name') as HTMLInputElement).value.trim();

      confirmBtn.disabled = true;
      confirmBtn.textContent = isEdit ? 'Saving...' : 'Creating...';

      try {
        const payload = buildConnectionPayload(
          card,
          currentProto,
          name,
          isEdit ? existing!.id : crypto.randomUUID(),
          isEdit ? existing!.parentId : parentId,
          isEdit ? existing!.orderIndex : Date.now()
        );

        if (!payload) {
          writeStatus('Unable to save connection: required fields are missing');
          confirmBtn.disabled = false;
          confirmBtn.textContent = isEdit ? 'Save' : 'Create';
          return;
        }

        await api.upsertConnection(payload);
        if (parentId) expandedFolders.add(parentId);
        hideModal();
        await refreshTree();
        writeStatus(isEdit ? 'Connection updated' : 'Connection created');
      } catch (error) {
        writeStatus(formatError(error));
        confirmBtn.disabled = false;
        confirmBtn.textContent = isEdit ? 'Save' : 'Create';
      }
    });

    wireModalEnterKey(card, '#modal-confirm');
  });
}

function showEditConnectionModal(node: ConnectionNode): void {
  showConnectionModal(node.kind as 'ssh' | 'rdp', node.parentId, node);
}

function renderSshFields(container: HTMLElement, existing: ConnectionNode | null): void {
  const ssh = existing?.ssh;
  container.innerHTML = `
    <div class="form-row">
      <div class="form-field">
        <label>Host</label>
        <input id="modal-ssh-host" type="text" placeholder="hostname or IP" value="${escapeAttr(ssh?.host ?? '')}" />
      </div>
      <div class="form-field">
        <label>Port</label>
        <input id="modal-ssh-port" type="text" placeholder="22" value="${escapeAttr(String(ssh?.port ?? 22))}" />
      </div>
    </div>
    <div class="form-field">
      <label>Username</label>
      <input id="modal-ssh-user" type="text" placeholder="Username" value="${escapeAttr(ssh?.username ?? '')}" />
    </div>
    <div class="form-field">
      <label>Password</label>
      <input id="modal-ssh-password" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
    </div>
    <div class="form-field">
      <label>Private Key Path</label>
      <input id="modal-ssh-key" type="text" placeholder="(optional)" value="${escapeAttr(ssh?.keyPath ?? '')}" />
    </div>
    <div class="form-field">
      <label>Key Passphrase</label>
      <input id="modal-ssh-key-pass" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
    </div>
    <div class="form-checkbox">
      <input id="modal-ssh-strict" type="checkbox" ${ssh?.strictHostKey !== false ? 'checked' : ''} />
      <label for="modal-ssh-strict">Strict Host Key Checking</label>
    </div>
  `;
}

function renderRdpFields(container: HTMLElement, existing: ConnectionNode | null): void {
  const rdp = existing?.rdp;
  const screenMode = rdp?.screenMode ?? 2;
  container.innerHTML = `
    <div class="form-row">
      <div class="form-field">
        <label>Host</label>
        <input id="modal-rdp-host" type="text" placeholder="hostname or IP" value="${escapeAttr(rdp?.host ?? '')}" />
      </div>
      <div class="form-field">
        <label>Port</label>
        <input id="modal-rdp-port" type="text" placeholder="3389" value="${escapeAttr(String(rdp?.port ?? 3389))}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label>Username</label>
        <input id="modal-rdp-user" type="text" placeholder="(optional)" value="${escapeAttr(rdp?.username ?? '')}" />
      </div>
      <div class="form-field">
        <label>Domain</label>
        <input id="modal-rdp-domain" type="text" placeholder="(optional)" value="${escapeAttr(rdp?.domain ?? '')}" />
      </div>
    </div>
    <div class="form-field">
      <label>Password</label>
      <input id="modal-rdp-password" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
    </div>
    <div class="form-field">
      <label>Screen Mode</label>
      <select id="modal-rdp-screen">
        <option value="1" ${screenMode === 1 ? 'selected' : ''}>Windowed</option>
        <option value="2" ${screenMode === 2 ? 'selected' : ''}>Fullscreen</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label>Width</label>
        <input id="modal-rdp-width" type="text" placeholder="(auto)" value="${escapeAttr(rdp?.width != null ? String(rdp.width) : '')}" />
      </div>
      <div class="form-field">
        <label>Height</label>
        <input id="modal-rdp-height" type="text" placeholder="(auto)" value="${escapeAttr(rdp?.height != null ? String(rdp.height) : '')}" />
      </div>
    </div>
  `;
}

type RequiredConnectionFieldRule = {
  selector: string;
  message: string;
};

function getRequiredConnectionFieldRules(proto: 'ssh' | 'rdp'): RequiredConnectionFieldRule[] {
  const rules: RequiredConnectionFieldRule[] = [{ selector: '#modal-conn-name', message: 'Name is required' }];

  if (proto === 'ssh') {
    rules.push(
      { selector: '#modal-ssh-host', message: 'Host is required' },
      { selector: '#modal-ssh-user', message: 'Username is required for SSH' }
    );
  } else {
    rules.push({ selector: '#modal-rdp-host', message: 'Host is required' });
  }

  return rules;
}

function findFirstMissingRequiredField(
  card: HTMLElement,
  proto: 'ssh' | 'rdp'
): { input: HTMLInputElement; message: string } | null {
  for (const rule of getRequiredConnectionFieldRules(proto)) {
    const input = card.querySelector<HTMLInputElement>(rule.selector);
    if (!input) continue;
    if (!input.value.trim()) {
      return { input, message: rule.message };
    }
  }

  return null;
}

function validateConnectionRequiredFields(
  card: HTMLElement,
  proto: 'ssh' | 'rdp'
): { ok: boolean; firstInvalid: HTMLInputElement | null; statusMessage: string } {
  let firstInvalid: HTMLInputElement | null = null;
  let statusMessage = '';

  for (const rule of getRequiredConnectionFieldRules(proto)) {
    const input = card.querySelector<HTMLInputElement>(rule.selector);
    if (!input) continue;

    if (!input.value.trim()) {
      setFieldInvalid(input, rule.message);
      if (!firstInvalid) {
        firstInvalid = input;
        statusMessage = rule.message;
      }
    }
  }

  return { ok: firstInvalid == null, firstInvalid, statusMessage };
}

function setFieldInvalid(input: HTMLInputElement, message: string): void {
  const field = input.closest<HTMLElement>('.form-field');
  if (!field) return;

  field.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');

  let errorEl = field.querySelector<HTMLElement>('.field-error');
  if (!errorEl) {
    errorEl = document.createElement('p');
    errorEl.className = 'field-error';
    field.appendChild(errorEl);
  }

  errorEl.textContent = message;
}

function clearFieldInvalid(input: HTMLInputElement | HTMLSelectElement): void {
  const field = input.closest<HTMLElement>('.form-field');
  if (!field) return;

  field.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
  field.querySelector('.field-error')?.remove();
}

function clearModalValidation(card: HTMLElement): void {
  for (const field of card.querySelectorAll<HTMLElement>('.form-field.is-invalid')) {
    field.classList.remove('is-invalid');
  }

  for (const input of card.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    '.form-field input[aria-invalid="true"], .form-field select[aria-invalid="true"]'
  )) {
    input.removeAttribute('aria-invalid');
  }

  for (const message of card.querySelectorAll<HTMLElement>('.field-error')) {
    message.remove();
  }
}

function buildConnectionPayload(
  card: HTMLElement,
  proto: 'ssh' | 'rdp',
  name: string,
  id: string,
  parentId: string | null,
  orderIndex: number
): ConnectionUpsert | null {
  if (proto === 'ssh') {
    const host = getModalValue(card, '#modal-ssh-host');
    const username = getModalValue(card, '#modal-ssh-user');
    if (!host) {
      return null;
    }
    if (!username) {
      return null;
    }

    const password = getModalOptional(card, '#modal-ssh-password');
    const keyPath = getModalOptional(card, '#modal-ssh-key');
    const keyPassphrase = getModalOptional(card, '#modal-ssh-key-pass');
    const strictHostKey = (card.querySelector('#modal-ssh-strict') as HTMLInputElement)?.checked ?? true;

    return {
      id,
      parentId,
      kind: 'ssh',
      name,
      orderIndex,
      ssh: {
        host,
        port: Number(getModalValue(card, '#modal-ssh-port') || '22'),
        username,
        strictHostKey,
        password,
        keyPath,
        keyPassphrase
      }
    };
  }

  // RDP
  const host = getModalValue(card, '#modal-rdp-host');
  if (!host) {
    return null;
  }

  const password = getModalOptional(card, '#modal-rdp-password');
  const username = getModalOptional(card, '#modal-rdp-user');
  const domain = getModalOptional(card, '#modal-rdp-domain');
  const widthStr = getModalValue(card, '#modal-rdp-width');
  const heightStr = getModalValue(card, '#modal-rdp-height');

  return {
    id,
    parentId,
    kind: 'rdp',
    name,
    orderIndex,
    rdp: {
      host,
      port: Number(getModalValue(card, '#modal-rdp-port') || '3389'),
      username,
      domain,
      screenMode: Number((card.querySelector('#modal-rdp-screen') as HTMLSelectElement)?.value ?? '2'),
      password,
      width: widthStr ? Number(widthStr) : null,
      height: heightStr ? Number(heightStr) : null
    }
  };
}

/* ── Rename Modal ─────────────────────────────────── */

function showRenameModal(node: ConnectionNode): void {
  showModal('Rename', (card) => {
    card.innerHTML += `
      <div class="form-field">
        <label>Name</label>
        <input id="modal-rename" type="text" value="${escapeAttr(node.name)}" />
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-confirm">Rename</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const name = (card.querySelector('#modal-rename') as HTMLInputElement).value.trim();
      if (!name) return;

      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Renaming...';

      try {
        if (node.kind === 'folder') {
          await api.upsertFolder({
            id: node.id,
            parentId: node.parentId,
            name,
            orderIndex: node.orderIndex
          });
        } else {
          // Upsert connection with new name, keeping existing config, no passwords sent
          const payload: ConnectionUpsert = {
            id: node.id,
            parentId: node.parentId,
            kind: node.kind as 'ssh' | 'rdp',
            name,
            orderIndex: node.orderIndex
          };

          if (node.kind === 'ssh' && node.ssh) {
            payload.ssh = {
              host: node.ssh.host,
              port: node.ssh.port,
              username: node.ssh.username,
              strictHostKey: node.ssh.strictHostKey,
              keyPath: node.ssh.keyPath ?? null
            };
          } else if (node.kind === 'rdp' && node.rdp) {
            payload.rdp = {
              host: node.rdp.host,
              port: node.rdp.port,
              username: node.rdp.username ?? null,
              domain: node.rdp.domain ?? null,
              screenMode: node.rdp.screenMode,
              width: node.rdp.width ?? null,
              height: node.rdp.height ?? null
            };
          }

          await api.upsertConnection(payload);
        }

        hideModal();
        await refreshTree();
        writeStatus('Renamed');
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = 'Rename';
      }
    });

    wireModalEnterKey(card, '#modal-confirm');
  });
}

/* ── Delete Modal ─────────────────────────────────── */

function showDeleteModal(node: ConnectionNode): void {
  showModal('Delete', (card) => {
    const p = document.createElement('p');
    p.style.color = 'var(--text-dim)';
    p.style.fontSize = '0.875rem';
    p.style.marginBottom = '0.75rem';
    p.textContent = `Are you sure you want to delete "${node.name}"?`;
    if (node.kind === 'folder') {
      p.textContent += ' This will also delete all children.';
    }
    card.appendChild(p);

    card.innerHTML += `
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-danger" id="modal-confirm">Delete</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Deleting...';

      try {
        await api.deleteNode(node.id);
        hideModal();
        await refreshTree();
        writeStatus('Deleted');
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
  });
}

/* ── Import Modal ─────────────────────────────────── */

function showImportModal(): void {
  showModal('Import mRemoteNG', (card) => {
    card.innerHTML += `
      <div class="form-field">
        <label>Path to mRemoteNG XML</label>
        <input id="modal-import-path" type="text" placeholder="C:\\path\\to\\confCons.xml" />
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn" id="modal-dry-run">Dry Run</button>
        <button class="btn btn-primary" id="modal-apply">Apply</button>
      </div>
      <div id="modal-import-report"></div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);

    card.querySelector('#modal-dry-run')!.addEventListener('click', async () => {
      const path = (card.querySelector('#modal-import-path') as HTMLInputElement).value.trim();
      if (!path) return;

      const btn = card.querySelector('#modal-dry-run') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Running...';

      try {
        const report = await api.importMremote({ path, mode: 'dry_run' });
        const reportEl = card.querySelector('#modal-import-report')!;
        reportEl.innerHTML = `<div class="import-report">Dry run: created=${report.created}, updated=${report.updated}, skipped=${report.skipped}${report.warnings.length ? '\nWarnings:\n' + report.warnings.map(escapeHtml).join('\n') : ''}</div>`;
      } catch (error) {
        writeStatus(formatError(error));
      }

      btn.disabled = false;
      btn.textContent = 'Dry Run';
    });

    card.querySelector('#modal-apply')!.addEventListener('click', async () => {
      const path = (card.querySelector('#modal-import-path') as HTMLInputElement).value.trim();
      if (!path) return;

      const btn = card.querySelector('#modal-apply') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Importing...';

      try {
        const report = await api.importMremote({ path, mode: 'apply' });
        const reportEl = card.querySelector('#modal-import-report')!;
        reportEl.innerHTML = `<div class="import-report">Applied: created=${report.created}, updated=${report.updated}, skipped=${report.skipped}${report.warnings.length ? '\nWarnings:\n' + report.warnings.map(escapeHtml).join('\n') : ''}</div>`;
        await refreshTree();
        writeStatus('Import applied');
      } catch (error) {
        writeStatus(formatError(error));
      }

      btn.disabled = false;
      btn.textContent = 'Apply';
    });
  });
}

/* ── Export Modal ──────────────────────────────────── */

function showExportModal(): void {
  showModal('Export mRemoteNG', (card) => {
    card.innerHTML += `
      <div class="form-field">
        <label>Export path</label>
        <input id="modal-export-path" type="text" placeholder="C:\\path\\to\\export.xml" />
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-confirm">Export</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const path = (card.querySelector('#modal-export-path') as HTMLInputElement).value.trim();
      if (!path) return;

      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Exporting...';

      try {
        await api.exportMremote(path);
        hideModal();
        writeStatus('Export complete');
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = 'Export';
      }
    });

    wireModalEnterKey(card, '#modal-confirm');
  });
}

/* ── SSH / RDP Session ────────────────────────────── */

async function openSshWithStatus(node: ConnectionNode): Promise<void> {
  try {
    const opened = await openSsh(node);
    if (opened) {
      writeStatus(`SSH ready: ${node.name}`);
    }
  } catch (error) {
    writeStatus(formatError(error));
  }
}

async function openSsh(node: ConnectionNode): Promise<boolean> {
  if (node.kind !== 'ssh' || !workspaceEl) return false;

  const sessionId = await openSshSession(node);
  if (!sessionId) {
    return false;
  }

  if (tabs.has(sessionId)) {
    activateTab(sessionId);
  }

  return true;
}

async function openSshSession(node: ConnectionNode): Promise<string | null> {
  if (node.kind !== 'ssh' || !workspaceEl) {
    throw new Error('cannot open non-SSH node');
  }

  const root = document.createElement('div');
  root.className = 'terminal';
  root.style.visibility = 'hidden';
  workspaceEl.appendChild(root);

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    theme: {
      background: '#181825',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de'
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(root);
  fitAddon.fit();

  const cols = Math.max(1, terminal.cols || 120);
  const rows = Math.max(1, terminal.rows || 32);

  let sessionId: string;
  try {
    const openResult = await api.openSsh(node.id, { cols, rows });
    if (openResult.type === 'hostKeyMismatch') {
      terminal.dispose();
      root.remove();
      showSshHostKeyMismatchModal(node, openResult);
      return null;
    }

    sessionId = openResult.sessionId;
  } catch (error) {
    terminal.dispose();
    root.remove();
    throw error;
  }

  root.style.visibility = '';
  root.style.display = 'none';

  const cleanup: Array<() => void> = [];
  try {
    const unlistenStdout = await api.listenStdout(sessionId, (data) => terminal.write(data));
    cleanup.push(unlistenStdout);

    const unlistenExit = await api.listenExit(sessionId, (code) => {
      terminal.writeln(`\r\n[session exited with code ${code}]`);
      void closeTab(sessionId);
    });
    cleanup.push(unlistenExit);

    const onDataDisposable = terminal.onData((data) => {
      void api.writeSsh(sessionId, data);
    });
    cleanup.push(() => onDataDisposable.dispose());
  } catch (error) {
    for (const fn of cleanup) fn();
    terminal.dispose();
    root.remove();
    await api.closeSsh(sessionId).catch(() => undefined);
    throw error;
  }

  tabs.set(sessionId, {
    kind: 'ssh',
    sessionId,
    baseTitle: node.name,
    title: nextTabTitle(node.name),
    root,
    terminal,
    fitAddon,
    cleanup
  });
  return sessionId;
}

function showSshHostKeyMismatchModal(
  node: ConnectionNode,
  mismatch: SshHostKeyMismatchResult
): void {
  showModal('SSH Host Key Warning', (card) => {
    card.innerHTML += `
      <div class="host-key-warning" role="alert">
        <p class="host-key-warning-summary">${escapeHtml(mismatch.warning)}</p>
        <p class="host-key-warning-target"><strong>Target:</strong> ${escapeHtml(mismatch.host)}:${escapeHtml(String(mismatch.port))}</p>
        <div class="host-key-warning-grid">
          <div>
            <p><strong>Saved key</strong></p>
            <p>Type: ${escapeHtml(mismatch.storedKeyType)}</p>
            <p>Fingerprint: ${escapeHtml(mismatch.storedFingerprint)}</p>
          </div>
          <div>
            <p><strong>Presented key</strong></p>
            <p>Type: ${escapeHtml(mismatch.presentedKeyType)}</p>
            <p>Fingerprint: ${escapeHtml(mismatch.presentedFingerprint)}</p>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-danger" id="modal-confirm">Update Saved Key &amp; Connect</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Updating...';

      try {
        await api.updateSshHostKeyFromMismatch(node.id, mismatch.token);
        hideModal();
        writeStatus('Saved updated host key; reconnecting...');
        await openSshWithStatus(node);
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = 'Update Saved Key & Connect';
      }
    });
  });
}

async function openRdp(node: ConnectionNode): Promise<void> {
  if (node.kind !== 'rdp' || !workspaceEl) return;

  const sessionId = await openRdpSession(node);
  if (tabs.has(sessionId)) {
    activateTab(sessionId);
  }
}

async function openRdpSession(node: ConnectionNode): Promise<string> {
  if (node.kind !== 'rdp' || !workspaceEl) {
    throw new Error('cannot open non-RDP node');
  }

  const root = document.createElement('div');
  root.className = 'rdp-canvas-container';
  root.style.display = 'none';
  workspaceEl.appendChild(root);

  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.width = node.rdp?.width ?? 1280;
  canvas.height = node.rdp?.height ?? 720;
  root.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    root.remove();
    throw new Error('Failed to get canvas 2d context');
  }

  let sessionId: string;
  try {
    sessionId = await api.openRdp(node.id);
  } catch (error) {
    root.remove();
    throw error;
  }

  const cleanup: Array<() => void> = [];
  try {
    const unlistenFrame = await api.listenRdpFrame(sessionId, (b64) => {
      void drawFrame(ctx, b64);
    });
    cleanup.push(unlistenFrame);

    const sid = sessionId;
    const unlistenExit = await api.listenRdpExit(sessionId, (_reason) => {
      void closeTab(sid);
    });
    cleanup.push(unlistenExit);

    // Mouse events
    let lastButtons = 0;

    const onMouseMove = (e: MouseEvent): void => {
      const { x, y } = canvasCoords(canvas, e);
      void api.rdpMouseEvent(sessionId, x, y, lastButtons, 0);
    };

    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault();
      canvas.focus();
      lastButtons = e.buttons;
      const { x, y } = canvasCoords(canvas, e);
      void api.rdpMouseEvent(sessionId, x, y, webButtonsToBitmask(e.buttons), 0);
    };

    const onMouseUp = (e: MouseEvent): void => {
      lastButtons = e.buttons;
      const { x, y } = canvasCoords(canvas, e);
      void api.rdpMouseEvent(sessionId, x, y, webButtonsToBitmask(e.buttons), 0);
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { x, y } = canvasCoords(canvas, e);
      const delta = Math.round(-e.deltaY / 10);
      void api.rdpMouseEvent(sessionId, x, y, webButtonsToBitmask(e.buttons), delta);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault();
      const mapped = browserKeyToRdp(e);
      if (mapped) {
        void api.rdpKeyEvent(sessionId, mapped.scancode, mapped.extended, false);
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      e.preventDefault();
      const mapped = browserKeyToRdp(e);
      if (mapped) {
        void api.rdpKeyEvent(sessionId, mapped.scancode, mapped.extended, true);
      }
    };

    const onContextMenu = (e: Event): void => {
      e.preventDefault();
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('contextmenu', onContextMenu);

    cleanup.push(() => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
    });
  } catch (error) {
    for (const fn of cleanup) fn();
    root.remove();
    await api.closeRdp(sessionId).catch(() => undefined);
    throw error;
  }

  tabs.set(sessionId, {
    kind: 'rdp',
    sessionId,
    baseTitle: node.name,
    title: nextTabTitle(node.name),
    root,
    canvas,
    ctx,
    cleanup
  });
  return sessionId;
}

/* ── RDP Helpers ──────────────────────────────────── */

async function drawFrame(ctx: CanvasRenderingContext2D, b64: string): Promise<void> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  ctx.canvas.width = bitmap.width;
  ctx.canvas.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

function canvasCoords(canvas: HTMLCanvasElement, e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY)
  };
}

function webButtonsToBitmask(buttons: number): number {
  // Web: bit 0=left, bit 1=right, bit 2=middle, bit 3=x1, bit 4=x2
  // Our backend expects same layout
  return buttons & 0x1f;
}

function browserKeyToRdp(e: KeyboardEvent): { scancode: number; extended: boolean } | null {
  const entry = SCANCODE_MAP[e.code];
  if (!entry) return null;
  return { scancode: entry[0], extended: entry[1] };
}

// PS/2 scancode map: KeyboardEvent.code → [scancode, extended]
const SCANCODE_MAP: Record<string, [number, boolean]> = {
  Escape: [0x01, false],
  Digit1: [0x02, false], Digit2: [0x03, false], Digit3: [0x04, false], Digit4: [0x05, false],
  Digit5: [0x06, false], Digit6: [0x07, false], Digit7: [0x08, false], Digit8: [0x09, false],
  Digit9: [0x0a, false], Digit0: [0x0b, false],
  Minus: [0x0c, false], Equal: [0x0d, false], Backspace: [0x0e, false], Tab: [0x0f, false],
  KeyQ: [0x10, false], KeyW: [0x11, false], KeyE: [0x12, false], KeyR: [0x13, false],
  KeyT: [0x14, false], KeyY: [0x15, false], KeyU: [0x16, false], KeyI: [0x17, false],
  KeyO: [0x18, false], KeyP: [0x19, false],
  BracketLeft: [0x1a, false], BracketRight: [0x1b, false], Enter: [0x1c, false],
  ControlLeft: [0x1d, false],
  KeyA: [0x1e, false], KeyS: [0x1f, false], KeyD: [0x20, false], KeyF: [0x21, false],
  KeyG: [0x22, false], KeyH: [0x23, false], KeyJ: [0x24, false], KeyK: [0x25, false],
  KeyL: [0x26, false],
  Semicolon: [0x27, false], Quote: [0x28, false], Backquote: [0x29, false],
  ShiftLeft: [0x2a, false], Backslash: [0x2b, false],
  KeyZ: [0x2c, false], KeyX: [0x2d, false], KeyC: [0x2e, false], KeyV: [0x2f, false],
  KeyB: [0x30, false], KeyN: [0x31, false], KeyM: [0x32, false],
  Comma: [0x33, false], Period: [0x34, false], Slash: [0x35, false],
  ShiftRight: [0x36, false],
  NumpadMultiply: [0x37, false],
  AltLeft: [0x38, false], Space: [0x39, false], CapsLock: [0x3a, false],
  F1: [0x3b, false], F2: [0x3c, false], F3: [0x3d, false], F4: [0x3e, false],
  F5: [0x3f, false], F6: [0x40, false], F7: [0x41, false], F8: [0x42, false],
  F9: [0x43, false], F10: [0x44, false],
  NumLock: [0x45, false], ScrollLock: [0x46, false],
  Numpad7: [0x47, false], Numpad8: [0x48, false], Numpad9: [0x49, false],
  NumpadSubtract: [0x4a, false],
  Numpad4: [0x4b, false], Numpad5: [0x4c, false], Numpad6: [0x4d, false],
  NumpadAdd: [0x4e, false],
  Numpad1: [0x4f, false], Numpad2: [0x50, false], Numpad3: [0x51, false],
  Numpad0: [0x52, false], NumpadDecimal: [0x53, false],
  F11: [0x57, false], F12: [0x58, false],
  // Extended keys
  NumpadEnter: [0x1c, true],
  ControlRight: [0x1d, true],
  NumpadDivide: [0x35, true],
  PrintScreen: [0x37, true],
  AltRight: [0x38, true],
  Home: [0x47, true], ArrowUp: [0x48, true], PageUp: [0x49, true],
  ArrowLeft: [0x4b, true], ArrowRight: [0x4d, true],
  End: [0x4f, true], ArrowDown: [0x50, true], PageDown: [0x51, true],
  Insert: [0x52, true], Delete: [0x53, true],
  MetaLeft: [0x5b, true], MetaRight: [0x5c, true], ContextMenu: [0x5d, true],
  Pause: [0x45, true]
};

function nextTabTitle(baseTitle: string): string {
  let count = 0;
  for (const tab of tabs.values()) {
    if (tab.baseTitle === baseTitle) {
      count += 1;
    }
  }

  return count === 0 ? baseTitle : `${baseTitle} (${count + 1})`;
}

/* ── Tab Management ───────────────────────────────── */

function renderTabs(): void {
  if (!tabsEl) return;

  tabsEl.replaceChildren();

  for (const tab of tabs.values()) {
    const el = document.createElement('div');
    el.className = `tab${activeTab === tab.sessionId ? ' active' : ''}`;

    const label = document.createElement('span');
    label.textContent = tab.title;
    el.appendChild(label);

    el.addEventListener('click', () => {
      activateTab(tab.sessionId);
    });
    el.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void closeTab(tab.sessionId);
      }
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void closeTab(tab.sessionId);
    });
    close.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.stopPropagation();
        event.preventDefault();
      }
    });
    close.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.stopPropagation();
        event.preventDefault();
        void closeTab(tab.sessionId);
      }
    });

    el.appendChild(close);
    tabsEl.appendChild(el);
  }
}

function activateTab(sessionId: string): void {
  activeTab = sessionId;

  for (const tab of tabs.values()) {
    tab.root.style.display = tab.sessionId === sessionId ? 'block' : 'none';
  }

  const tab = tabs.get(sessionId);
  if (tab?.kind === 'rdp') {
    tab.canvas.focus();
  } else {
    scheduleActiveTabResize();
  }
  renderTabs();
}

async function closeTab(sessionId: string): Promise<void> {
  const tab = tabs.get(sessionId);
  if (!tab) return;

  if (tab.kind === 'ssh') {
    await api.closeSsh(sessionId).catch(() => undefined);
    tab.terminal.dispose();
  } else {
    await api.closeRdp(sessionId).catch(() => undefined);
  }
  for (const fn of tab.cleanup) fn();
  tab.root.remove();
  tabs.delete(sessionId);

  if (activeTab === sessionId) {
    activeTab = tabs.keys().next().value ?? null;
    if (activeTab) {
      activateTab(activeTab);
    }
  }

  renderTabs();
}

function resizeActiveTab(): void {
  if (!activeTab) return;

  const tab = tabs.get(activeTab);
  if (!tab) return;

  if (!tab.root.isConnected || tab.root.style.display === 'none') {
    return;
  }

  fitAndResizeTab(tab);
}

function fitAndResizeTab(tab: SessionTab): void {
  if (tab.kind !== 'ssh') return;
  tab.fitAddon.fit();
  const cols = Math.max(1, tab.terminal.cols);
  const rows = Math.max(1, tab.terminal.rows);
  void api.resizeSsh(tab.sessionId, cols, rows);
}

function scheduleActiveTabResize(): void {
  if (pendingTabResizeFrame !== null) return;

  pendingTabResizeFrame = window.requestAnimationFrame(() => {
    pendingTabResizeFrame = null;
    resizeActiveTab();
  });
}

function toggleFileMenu(): void {
  setFileMenuOpen(!fileMenuOpen);
}

function setFileMenuOpen(nextOpen: boolean): void {
  fileMenuOpen = nextOpen;
  if (fileMenuEl) {
    fileMenuEl.classList.toggle('visible', nextOpen);
    fileMenuEl.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  }
  if (fileMenuTriggerEl) {
    fileMenuTriggerEl.classList.toggle('open', nextOpen);
    fileMenuTriggerEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }
}

function updateVaultLockState(): void {
  if (!vaultLockEl) return;

  const locked = !vaultUnlocked;
  vaultLockEl.disabled = locked;
  vaultLockEl.classList.toggle('is-locked', locked);
  vaultLockEl.setAttribute('aria-label', locked ? 'Vault locked' : 'Lock vault');
  vaultLockEl.title = locked ? 'Vault locked' : 'Lock vault';
  vaultLockEl.innerHTML = vaultLockIconSvg(locked);
}

function vaultLockIconSvg(locked: boolean): string {
  if (locked) {
    return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 7V5.75a3.5 3.5 0 117 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="10.5" r="0.9" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 7V5.75a3.5 3.5 0 00-6.34-2.02" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="10.5" r="0.9" fill="currentColor"/></svg>`;
}

function loadAppVersion(): void {
  const target = appVersionEl;
  if (!target) return;
  target.textContent = APP_VERSION ? `v${APP_VERSION}` : 'v?';
}

function parseCargoPackageVersion(toml: string): string | null {
  let inPackageSection = false;
  const lines = toml.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inPackageSection = trimmed === '[package]';
      continue;
    }

    if (!inPackageSection) continue;

    const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/* ── Utility ──────────────────────────────────────── */

function writeStatus(message: string): void {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

async function withStatus(message: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    writeStatus(message);
  } catch (error) {
    writeStatus(formatError(error));
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

function getModalValue(container: HTMLElement, selector: string): string {
  const el = container.querySelector<HTMLInputElement>(selector);
  return el?.value.trim() ?? '';
}

function getModalOptional(container: HTMLElement, selector: string): string | null {
  const v = getModalValue(container, selector);
  return v.length > 0 ? v : null;
}

function wireModalEnterKey(card: HTMLElement, confirmSelector: string): void {
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      card.querySelector<HTMLButtonElement>(confirmSelector)?.click();
    }
  });
}

function applyInputPrivacyAttributes(root: ParentNode): void {
  const forms = root.querySelectorAll<HTMLFormElement>('form');
  for (const form of forms) {
    form.setAttribute('autocomplete', 'off');
  }

  const inputs = root.querySelectorAll<HTMLInputElement>('input');
  for (const input of inputs) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();

    if (type === 'hidden' || type === 'checkbox' || type === 'radio') {
      continue;
    }

    if (type === 'password') {
      input.setAttribute('autocomplete', 'new-password');
    } else {
      input.setAttribute('autocomplete', 'off');
    }

    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
  }
}

function resetMainShellState(): void {
  if (workspaceResizeObserver) {
    workspaceResizeObserver.disconnect();
    workspaceResizeObserver = null;
  }
  if (pendingTabResizeFrame !== null) {
    window.cancelAnimationFrame(pendingTabResizeFrame);
    pendingTabResizeFrame = null;
  }

  treeEl = null;
  tabsEl = null;
  workspaceEl = null;
  appShellEl = null;
  unlockOverlayEl = null;
  unlockInputEl = null;
  unlockStatusEl = null;
  contextMenuEl = null;
  modalOverlayEl = null;
  fileMenuTriggerEl = null;
  fileMenuEl = null;
  vaultLockEl = null;
  appVersionEl = null;
  vaultUnlocked = false;
  fileMenuOpen = false;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
