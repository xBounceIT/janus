import './styles.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { api } from './api';
import type { ConnectionNode, ConnectionUpsert, NodeKind } from './types';

/* ── Types ────────────────────────────────────────── */

type SessionTab = {
  sessionId: string;
  connectionId: string;
  title: string;
  root: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  cleanup: Array<() => void>;
};

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
let vaultUnlocked = false;

/* ── Session state ────────────────────────────────── */

const tabs = new Map<string, SessionTab>();
const connectionToSession = new Map<string, string>();
const openingSessions = new Map<string, Promise<string>>();
let nodes: ConnectionNode[] = [];
let activeTab: string | null = null;

/* ── Tree state ───────────────────────────────────── */

const expandedFolders = new Set<string | null>([null]);
let selectedNodeId: string | null = null;

/* ── Boot ─────────────────────────────────────────── */

void api.listenErrors((message) => writeStatus(message));

window.addEventListener('resize', () => {
  resizeActiveTab();
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
  };

  renderStep();
}

/* ── Main App ─────────────────────────────────────── */

function renderMainApp(initiallyUnlocked: boolean): void {
  app.innerHTML = `
    <div id="app-shell" class="app-shell">
      <div class="app-toolbar">
        <span class="app-title">Janus</span>
        <div class="toolbar-spacer"></div>
        <button class="btn btn-sm" id="import-btn">Import</button>
        <button class="btn btn-sm" id="export-btn">Export</button>
        <button class="btn btn-sm" id="vault-lock">Lock</button>
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
      <div class="status-bar"><span id="status"></span></div>
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

  tabs.clear();
  connectionToSession.clear();
  openingSessions.clear();
  nodes = [];
  activeTab = null;
  selectedNodeId = null;
  expandedFolders.clear();
  expandedFolders.add(null);

  wireToolbar();
  wireUnlockModal();
  wireSidebarResizer();
  wireGlobalKeyboard();
  wireContextMenuDismiss();
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
    try {
      await api.vaultLock();
      showUnlockModal();
      writeStatus('Vault locked');
    } catch (error) {
      writeStatus(formatError(error));
    }
  });

  must<HTMLButtonElement>('#import-btn').addEventListener('click', () => {
    showImportModal();
  });

  must<HTMLButtonElement>('#export-btn').addEventListener('click', () => {
    showExportModal();
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
  if (appShellEl) {
    appShellEl.classList.toggle('locked', !vaultUnlocked);
  }
  if (unlockOverlayEl) {
    unlockOverlayEl.classList.toggle('visible', !vaultUnlocked);
    unlockOverlayEl.setAttribute('aria-hidden', vaultUnlocked ? 'true' : 'false');
  }
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
    };

    const onUp = (): void => {
      dragging = false;
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizeActiveTab();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ── Global Keyboard ──────────────────────────────── */

function wireGlobalKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
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
        void withStatus(`SSH ready: ${node.name}`, () => openSsh(node));
      } else if (node.kind === 'rdp') {
        void withStatus('Launching RDP', () => api.launchRdp(node.id));
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
    { label: 'New SSH Connection', action: () => showConnectionModal('ssh', parentId) },
    { label: 'New RDP Connection', action: () => showConnectionModal('rdp', parentId) }
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
        void withStatus(`SSH ready: ${node.name}`, () => openSsh(node));
      }
    });
  } else if (node.kind === 'rdp') {
    items.push({
      label: 'Open RDP',
      action: () => {
        void withStatus('Launching RDP', () => api.launchRdp(node.id));
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

    const renderProtoFields = (): void => {
      if (currentProto === 'ssh') {
        renderSshFields(fieldsDiv, isEdit ? existing : null);
      } else {
        renderRdpFields(fieldsDiv, isEdit ? existing : null);
      }
    };

    renderProtoFields();

    // Protocol tab switching (only in create mode)
    if (!isEdit) {
      for (const btn of tabsDiv.querySelectorAll<HTMLButtonElement>('.protocol-tab')) {
        btn.addEventListener('click', () => {
          currentProto = btn.dataset.proto as 'ssh' | 'rdp';
          for (const b of tabsDiv.querySelectorAll('.protocol-tab')) b.classList.remove('active');
          btn.classList.add('active');
          renderProtoFields();
        });
      }
    }

    // Actions
    card.innerHTML += `
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-confirm">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    `;

    card.querySelector('#modal-cancel')!.addEventListener('click', hideModal);
    card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
      const name = (card.querySelector('#modal-conn-name') as HTMLInputElement).value.trim();
      if (!name) {
        writeStatus('Name is required');
        return;
      }

      const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = isEdit ? 'Saving...' : 'Creating...';

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
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save' : 'Create';
          return;
        }

        await api.upsertConnection(payload);
        if (parentId) expandedFolders.add(parentId);
        hideModal();
        await refreshTree();
        writeStatus(isEdit ? 'Connection updated' : 'Connection created');
      } catch (error) {
        writeStatus(formatError(error));
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save' : 'Create';
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
      writeStatus('Host is required');
      return null;
    }
    if (!username) {
      writeStatus('Username is required for SSH');
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
    writeStatus('Host is required');
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

async function openSsh(node: ConnectionNode): Promise<void> {
  if (node.kind !== 'ssh' || !workspaceEl) return;

  const existingSessionId = connectionToSession.get(node.id);
  if (existingSessionId) {
    if (tabs.has(existingSessionId)) {
      activateTab(existingSessionId);
      return;
    }

    connectionToSession.delete(node.id);
  }

  const openingSession = openingSessions.get(node.id);
  if (openingSession) {
    const openingSessionId = await openingSession;
    if (tabs.has(openingSessionId)) {
      activateTab(openingSessionId);
    }
    return;
  }

  const openPromise = openSshSession(node);
  openingSessions.set(node.id, openPromise);

  try {
    const sessionId = await openPromise;
    if (tabs.has(sessionId)) {
      activateTab(sessionId);
    }
  } finally {
    if (openingSessions.get(node.id) === openPromise) {
      openingSessions.delete(node.id);
    }
  }
}

async function openSshSession(node: ConnectionNode): Promise<string> {
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
    sessionId = await api.openSsh(node.id, { cols, rows });
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
      terminal.writeln(`\r\n[session exited with ${code}]`);
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
    sessionId,
    connectionId: node.id,
    title: node.name,
    root,
    terminal,
    fitAddon,
    cleanup
  });
  connectionToSession.set(node.id, sessionId);

  terminal.writeln(`Connected to ${node.ssh?.host ?? node.name}`);
  return sessionId;
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

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void closeTab(tab.sessionId);
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

  resizeActiveTab();
  renderTabs();
}

async function closeTab(sessionId: string): Promise<void> {
  const tab = tabs.get(sessionId);
  if (!tab) return;

  await api.closeSsh(sessionId);
  for (const fn of tab.cleanup) fn();
  tab.terminal.dispose();
  tab.root.remove();
  tabs.delete(sessionId);
  if (connectionToSession.get(tab.connectionId) === sessionId) {
    connectionToSession.delete(tab.connectionId);
  }

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

  tab.fitAddon.fit();
  const cols = Math.max(1, tab.terminal.cols);
  const rows = Math.max(1, tab.terminal.rows);
  void api.resizeSsh(tab.sessionId, cols, rows);
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

function resetMainShellState(): void {
  treeEl = null;
  tabsEl = null;
  workspaceEl = null;
  appShellEl = null;
  unlockOverlayEl = null;
  unlockInputEl = null;
  unlockStatusEl = null;
  contextMenuEl = null;
  modalOverlayEl = null;
  vaultUnlocked = false;
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
