import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { FitAddon } from '@xterm/addon-fit';
import cargoToml from '../src-tauri/Cargo.toml?raw';
import { Terminal } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from './api';
import type {
  ConnectionNode,
  ConnectionUpsert,
  FileEntry,
  FileEntryKind,
  FileListResult,
  NodeKind,
  RdpLifecycleEvent,
  RdpViewport,
  SshHostKeyMismatchResult
} from './types';

/* ── Types ────────────────────────────────────────── */

type SshSessionTab = {
  kind: 'ssh';
  connectionId: string;
  sessionId: string | null;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  sshState: 'connecting' | 'connected' | 'exited';
  exitCode: number | null;
  cleanup: Array<() => void>;
};

type RdpSessionTab = {
  kind: 'rdp';
  connectionId: string;
  sessionId: string | null;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  rdpState: 'connecting' | 'connected' | 'error';
  cleanup: Array<() => void>;
};

type SessionTab = SshSessionTab | RdpSessionTab;
type PreferencesSectionId = 'ui' | 'security' | 'advanced';
type FilePaneSide = 'local' | 'remote';

type PreferencesSectionDefinition = {
  id: PreferencesSectionId;
  label: string;
  icon: string;
  description: string;
  placeholders: Array<{ label: string; hint: string }>;
};

type SftpPaneState = {
  side: FilePaneSide;
  cwd: string;
  entries: FileEntry[];
  selectedPath: string | null;
  selectedKind: FileEntryKind | null;
  loading: boolean;
  rootEl: HTMLDivElement | null;
  pathEl: HTMLInputElement | null;
  listEl: HTMLDivElement | null;
};

type SftpModalState = {
  tabKey: string;
  sshSessionId: string;
  connectionName: string;
  sftpSessionId: string | null;
  closing: boolean;
  activePane: FilePaneSide;
  local: SftpPaneState;
  remote: SftpPaneState;
  card: HTMLDivElement | null;
  statusEl: HTMLParagraphElement | null;
};

/* ── DOM refs ─────────────────────────────────────── */

const app = must<HTMLDivElement>('#app');

let statusEl: HTMLElement | null = null;
let pingStatusEl: HTMLElement | null = null;
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
let settingsMenuTriggerEl: HTMLButtonElement | null = null;
let settingsMenuEl: HTMLDivElement | null = null;
let vaultLockEl: HTMLButtonElement | null = null;
let appVersionEl: HTMLSpanElement | null = null;
let modalOnHide: (() => void | Promise<void>) | null = null;
let activeSftpModal: SftpModalState | null = null;
let vaultUnlocked = false;
let fileMenuOpen = false;
let settingsMenuOpen = false;
let nativeContextMenuSuppressed = false;
const APP_VERSION = parseCargoPackageVersion(cargoToml);
const PREFERENCES_SECTIONS: PreferencesSectionDefinition[] = [
  {
    id: 'ui',
    label: 'UI',
    icon: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M2.75 6h10.5" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="4.15" r=".6" fill="currentColor"/><circle cx="6.5" cy="4.15" r=".6" fill="currentColor"/></svg>`,
    description: 'Interface and layout preferences for the desktop app.',
    placeholders: [
      { label: 'Theme', hint: 'Choose a visual theme and contrast mode.' },
      { label: 'Sidebar', hint: 'Control default width and panel behavior.' },
      { label: 'Workspace', hint: 'Tune tab and viewport display defaults.' }
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.8l4.6 1.9v3.7c0 3.05-1.88 5.36-4.6 6.8-2.72-1.44-4.6-3.75-4.6-6.8V3.7L8 1.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.5 7.9l1 1 2-2.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    description: 'Vault handling and connection security defaults.',
    placeholders: [
      { label: 'Vault Locking', hint: 'Idle timeout and lock behavior.' },
      { label: 'SSH Host Keys', hint: 'Default handling for host key prompts.' },
      { label: 'Credential Prompts', hint: 'Prompting and caching preferences.' }
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.2V1.9M8 14.1v-1.3M12.8 8h1.3M1.9 8h1.3M11.39 4.61l.92-.92M3.69 12.31l.92-.92M11.39 11.39l.92.92M3.69 3.69l.92.92" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="8" r="2.3" stroke="currentColor" stroke-width="1.2"/></svg>`,
    description: 'Power-user defaults and diagnostics-related options.',
    placeholders: [
      { label: 'Logging', hint: 'Adjust diagnostics and troubleshooting output.' },
      { label: 'Import / Export', hint: 'Default file format and validation behavior.' },
      { label: 'Developer Options', hint: 'Experimental features and debug toggles.' }
    ]
  }
];

/* ── Session state ────────────────────────────────── */

const tabs = new Map<string, SessionTab>();
let nodes: ConnectionNode[] = [];
let activeTab: string | null = null;
let workspaceResizeObserver: ResizeObserver | null = null;
let pendingTabResizeFrame: number | null = null;
const SSH_OPEN_WATCHDOG_TIMEOUT_MS = 12_000;
const SSH_OPEN_WATCHDOG_ERROR = 'SSH open timed out waiting for backend response';

/* ── Tree state ───────────────────────────────────── */

const expandedFolders = new Set<string | null>([null]);
let selectedNodeId: string | null = null;
let pingRequestSeq = 0;

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
        <div class="menu-root">
          <button class="menu-trigger" id="settings-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="settings-menu">Settings</button>
          <div id="settings-menu" class="menu-panel" role="menu" aria-hidden="true">
            <button class="menu-item" id="settings-preferences" role="menuitem">Preferences</button>
            <button class="menu-item" id="settings-about" role="menuitem">About</button>
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
        <span id="ping-status" class="ping-status" aria-live="polite"></span>
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

  statusEl = null;
  pingStatusEl = must<HTMLSpanElement>('#ping-status');
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
  settingsMenuTriggerEl = must<HTMLButtonElement>('#settings-menu-trigger');
  settingsMenuEl = must<HTMLDivElement>('#settings-menu');
  vaultLockEl = must<HTMLButtonElement>('#vault-lock');
  appVersionEl = must<HTMLSpanElement>('#app-version');

  tabs.clear();
  nodes = [];
  activeTab = null;
  selectedNodeId = null;
  pingRequestSeq = 0;
  expandedFolders.clear();
  expandedFolders.add(null);
  clearPingStatus();

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
  must<HTMLButtonElement>('#settings-menu-trigger').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSettingsMenu();
  });

  must<HTMLButtonElement>('#file-import').addEventListener('click', () => {
    setFileMenuOpen(false);
    showImportModal();
  });

  must<HTMLButtonElement>('#file-export').addEventListener('click', () => {
    setFileMenuOpen(false);
    showExportModal();
  });

  must<HTMLButtonElement>('#settings-preferences').addEventListener('click', () => {
    setSettingsMenuOpen(false);
    showPreferencesModal();
  });

  must<HTMLButtonElement>('#settings-about').addEventListener('click', () => {
    setSettingsMenuOpen(false);
    showAboutModal();
  });

  document.addEventListener('click', (event) => {
    if (!fileMenuOpen && !settingsMenuOpen) return;
    const target = event.target as Node;
    if (
      fileMenuEl?.contains(target) ||
      fileMenuTriggerEl?.contains(target) ||
      settingsMenuEl?.contains(target) ||
      settingsMenuTriggerEl?.contains(target)
    ) {
      return;
    }
    if (fileMenuOpen) setFileMenuOpen(false);
    if (settingsMenuOpen) setSettingsMenuOpen(false);
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
      if (settingsMenuOpen) {
        setSettingsMenuOpen(false);
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

    if (isFolder || !id) {
      pingRequestSeq += 1;
      clearPingStatus();
      return;
    }

    const node = nodes.find((n) => n.id === id);
    if (!node || (node.kind !== 'ssh' && node.kind !== 'rdp')) {
      pingRequestSeq += 1;
      clearPingStatus();
      return;
    }

    void pingSelectedConnection(node.id, node.name);
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

type MenuAction =
  | { label: string; icon?: string; danger?: boolean; disabled?: boolean; action: () => void }
  | 'separator';

function disconnectIcon(): string {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><line x1="5.75" y1="5.75" x2="10.25" y2="10.25"/><line x1="10.25" y1="5.75" x2="5.75" y2="10.25"/></svg>';
}

function reconnectIcon(): string {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8A5 5 0 1 1 8 3"/><polyline points="13 3 13 7 9 7"/></svg>';
}

function duplicateIcon(): string {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>';
}

function sftpIcon(): string {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="5.5" height="4" rx="1"/><rect x="9" y="9.5" width="5.5" height="4" rx="1"/><path d="M7 4.5h2.5a1.5 1.5 0 0 1 1.5 1.5V9"/><path d="M9.5 7.5 11 9l1.5-1.5"/></svg>';
}

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

function buildTabMenuActions(tabKey: string, tab: SessionTab): MenuAction[] {
  const items: MenuAction[] = [];

  if (tab.kind === 'ssh') {
    items.push({
      label: 'Open SFTP',
      icon: sftpIcon(),
      disabled: tab.sshState !== 'connected' || !tab.sessionId,
      action: () => {
        void openSftpModalForTab(tabKey);
      }
    });
    items.push('separator');
  }

  items.push({
    label: 'Disconnect',
    icon: disconnectIcon(),
    danger: true,
    action: () => {
      void closeTab(tabKey);
    }
  });

  items.push({
    label: 'Reconnect',
    icon: reconnectIcon(),
    action: () => {
      const node = nodes.find((n) => n.id === tab.connectionId);
      if (!node) {
        writeStatus('Connection no longer exists');
        return;
      }
      void closeTab(tabKey).then(() => {
        if (node.kind === 'ssh') {
          void openSshWithStatus(node);
        } else if (node.kind === 'rdp') {
          void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
        }
      });
    }
  });

  items.push({
    label: 'Duplicate',
    icon: duplicateIcon(),
    action: () => {
      const node = nodes.find((n) => n.id === tab.connectionId);
      if (!node) {
        writeStatus('Connection no longer exists');
        return;
      }
      if (node.kind === 'ssh') {
        void openSshWithStatus(node);
      } else if (node.kind === 'rdp') {
        void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
      }
    }
  });

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
    item.className = `context-menu-item${action.danger ? ' danger' : ''}${action.disabled ? ' disabled' : ''}`;

    if (action.icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'context-menu-icon';
      iconSpan.innerHTML = action.icon;
      item.appendChild(iconSpan);
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = action.label;
    item.appendChild(labelSpan);

    item.addEventListener('click', () => {
      if (action.disabled) return;
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
  modalOnHide = null;

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
  const onHide = modalOnHide;
  modalOnHide = null;
  modalOverlayEl?.classList.remove('visible');
  if (onHide) {
    Promise.resolve(onHide()).catch(() => undefined);
  }
}

function showAboutModal(): void {
  showModal('About', (card) => {
    const body = document.createElement('div');
    body.className = 'about-modal-copy';

    const lead = document.createElement('p');
    lead.textContent = 'Janus is a local-first connection manager for SSH and RDP sessions.';
    body.appendChild(lead);

    const detail = document.createElement('p');
    detail.textContent = 'This desktop build stores connection data locally and exposes protocol tools through the workspace UI.';
    body.appendChild(detail);

    const meta = document.createElement('p');
    meta.className = 'about-modal-meta';
    meta.textContent = `Version ${APP_VERSION ?? '?'} · `;
    const repoLink = document.createElement('a');
    repoLink.className = 'about-modal-link';
    repoLink.href = '#';
    repoLink.textContent = 'GitHub';
    repoLink.addEventListener('click', (e) => {
      e.preventDefault();
      openUrl('https://github.com/xBounceIT/janus');
    });
    meta.appendChild(repoLink);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const bugBtn = document.createElement('button');
    bugBtn.className = 'btn btn-ghost';
    bugBtn.type = 'button';
    bugBtn.textContent = 'Report Bug';
    bugBtn.addEventListener('click', () => {
      openUrl('https://github.com/xBounceIT/janus/issues/new');
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', hideModal);

    actions.append(bugBtn, closeBtn);
    card.append(body, meta, actions);

    window.setTimeout(() => closeBtn.focus(), 0);
  });
}

function showPreferencesModal(): void {
  showModal('Preferences', (card) => {
    card.classList.add('preferences-modal');

    let selectedSection: PreferencesSectionId = 'ui';
    const layout = document.createElement('div');
    layout.className = 'preferences-layout';

    const nav = document.createElement('div');
    nav.className = 'preferences-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Preferences sections');

    const pane = document.createElement('section');
    pane.className = 'preferences-pane';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', hideModal);
    actions.appendChild(closeBtn);

    layout.append(nav, pane);
    card.append(layout, actions);

    const renderSection = (): void => {
      nav.replaceChildren();
      pane.replaceChildren();

      for (const section of PREFERENCES_SECTIONS) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `preferences-nav-item${section.id === selectedSection ? ' active' : ''}`;
        item.setAttribute('aria-pressed', section.id === selectedSection ? 'true' : 'false');

        const icon = document.createElement('span');
        icon.className = 'preferences-nav-icon';
        icon.innerHTML = section.icon;

        const label = document.createElement('span');
        label.className = 'preferences-nav-label';
        label.textContent = section.label;

        item.append(icon, label);
        item.addEventListener('click', () => {
          if (selectedSection === section.id) return;
          selectedSection = section.id;
          renderSection();
        });
        nav.appendChild(item);
      }

      const section = PREFERENCES_SECTIONS.find((entry) => entry.id === selectedSection) ?? PREFERENCES_SECTIONS[0];
      if (!section) return;

      const title = document.createElement('h3');
      title.textContent = section.label;

      const copy = document.createElement('p');
      copy.className = 'preferences-pane-copy';
      copy.textContent = section.description;

      const placeholderList = document.createElement('div');
      placeholderList.className = 'preferences-placeholder-list';

      for (const row of section.placeholders) {
        const rowEl = document.createElement('div');
        rowEl.className = 'preferences-placeholder-row';

        const textWrap = document.createElement('div');
        textWrap.className = 'preferences-placeholder-copy';

        const rowTitle = document.createElement('p');
        rowTitle.className = 'preferences-placeholder-title';
        rowTitle.textContent = row.label;

        const rowHint = document.createElement('p');
        rowHint.className = 'preferences-placeholder-hint';
        rowHint.textContent = row.hint;

        textWrap.append(rowTitle, rowHint);

        const badge = document.createElement('span');
        badge.className = 'preferences-placeholder-badge';
        badge.textContent = 'Coming soon';

        rowEl.append(textWrap, badge);
        placeholderList.appendChild(rowEl);
      }

      pane.append(title, copy, placeholderList);
    };

    renderSection();
    window.setTimeout(() => nav.querySelector<HTMLButtonElement>('.preferences-nav-item.active')?.focus(), 0);
  });
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
  writeStatus(`Opening SSH: ${node.name}...`);
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
  if (node.kind !== 'ssh') {
    throw new Error('cannot open non-SSH node');
  }
  if (!workspaceEl) {
    throw new Error('SSH workspace unavailable');
  }

  const sessionId = await openSshSession(node);
  if (!sessionId) {
    return false;
  }

  if (!tabs.has(sessionId)) {
    throw new Error('SSH tab initialization failed');
  }
  activateTab(sessionId);

  return true;
}

async function openSshSession(node: ConnectionNode): Promise<string | null> {
  if (node.kind !== 'ssh' || !workspaceEl) {
    throw new Error('cannot open non-SSH node');
  }

  // Generate sessionId upfront so we can register listeners before calling the backend
  const sessionId = crypto.randomUUID();
  const root = document.createElement('div');
  root.className = 'terminal';
  root.style.display = 'none';
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
  const overlay = document.createElement('div');
  overlay.className = 'conn-overlay connecting';
  overlay.innerHTML = `
    <div class="conn-loader" aria-hidden="true"></div>
    <p class="conn-overlay-text" aria-live="polite">Connecting...</p>
  `;
  root.appendChild(overlay);

  terminal.open(root);
  fitAddon.fit();

  const cols = Math.max(1, terminal.cols || 120);
  const rows = Math.max(1, terminal.rows || 32);

  const cleanup: Array<() => void> = [];
  const tab: SshSessionTab = {
    kind: 'ssh',
    connectionId: node.id,
    sessionId,
    baseTitle: node.name,
    title: nextTabTitle(node.name),
    root,
    overlay,
    terminal,
    fitAddon,
    sshState: 'connecting',
    exitCode: null,
    cleanup
  };
  tabs.set(sessionId, tab);
  activateTab(sessionId);

  // Register event listeners BEFORE calling the backend so no events are missed
  try {
    const unlistenStdout = await api.listenStdout(sessionId, (data) => terminal.write(data));
    cleanup.push(unlistenStdout);

    const unlistenExit = await api.listenExit(sessionId, (code) => {
      terminal.writeln(`\r\n[session exited with code ${code}]`);
      const current = tabs.get(sessionId);
      if (!current || current.kind !== 'ssh' || current.sshState === 'exited') {
        return;
      }
      if (current.sshState === 'connecting' && code !== 0) {
        setOverlayState(current.overlay, 'error', `Connection failed (exit code ${code})`);
      }
      current.sshState = 'exited';
      current.exitCode = code;
      renderTabs();
    });
    cleanup.push(unlistenExit);

    const onDataDisposable = terminal.onData((data) => {
      const current = tabs.get(sessionId);
      if (!current || current.kind !== 'ssh' || current.sshState !== 'connected') {
        return;
      }
      void api.writeSsh(sessionId, data).catch(() => undefined);
    });
    cleanup.push(() => onDataDisposable.dispose());
  } catch (error) {
    for (const fn of cleanup) fn();
    tabs.delete(sessionId);
    terminal.dispose();
    root.remove();
    finalizeTabRemoval(sessionId);
    throw error;
  }

  // Now call the backend, passing our pre-generated sessionId
  try {
    const openPromise = api.openSsh(node.id, { cols, rows, sessionId });
    let watchdogTimer: number | null = null;
    const watchdogPromise = new Promise<never>((_resolve, reject) => {
      watchdogTimer = window.setTimeout(() => {
        reject(new Error(SSH_OPEN_WATCHDOG_ERROR));
      }, SSH_OPEN_WATCHDOG_TIMEOUT_MS);
    });

    let openResult: Awaited<ReturnType<typeof api.openSsh>>;
    try {
      openResult = (await Promise.race([openPromise, watchdogPromise])) as Awaited<
        ReturnType<typeof api.openSsh>
      >;
    } catch (error) {
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
      }
      if (error instanceof Error && error.message === SSH_OPEN_WATCHDOG_ERROR) {
        void openPromise
          .then((lateResult) => {
            if (lateResult.type === 'opened') {
              void api.closeSsh(lateResult.sessionId).catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }
      throw error;
    }

    if (watchdogTimer !== null) {
      window.clearTimeout(watchdogTimer);
    }

    const current = tabs.get(sessionId);
    if (!current || current.kind !== 'ssh') {
      if (openResult.type === 'opened') {
        await api.closeSsh(openResult.sessionId).catch(() => undefined);
      }
      terminal.dispose();
      root.remove();
      return null;
    }

    if (openResult.type === 'hostKeyMismatch') {
      writeStatus(`SSH host key verification required for ${openResult.host}:${openResult.port}`);
      for (const fn of cleanup) fn();
      tabs.delete(sessionId);
      terminal.dispose();
      root.remove();
      finalizeTabRemoval(sessionId);
      showSshHostKeyMismatchModal(node, openResult);
      return null;
    }

    // Guard: if exit already fired before open returned, don't overwrite 'exited' state
    if (current.sshState !== 'exited') {
      current.sshState = 'connected';
      setOverlayState(current.overlay, 'connected', '');
    }
    renderTabs();
  } catch (error) {
    const failedTab = tabs.get(sessionId);
    if (failedTab && failedTab.kind === 'ssh') {
      setOverlayState(failedTab.overlay, 'error', formatError(error));
    }
    for (const fn of cleanup) fn();
    tabs.delete(sessionId);
    terminal.dispose();
    root.remove();
    finalizeTabRemoval(sessionId);
    throw error;
  }

  return sessionId;
}

function showSshHostKeyMismatchModal(
  node: ConnectionNode,
  mismatch: SshHostKeyMismatchResult
): void {
  if (!modalOverlayEl) {
    writeStatus(
      `${mismatch.warning} Target ${mismatch.host}:${mismatch.port} (${mismatch.presentedFingerprint})`
    );
    return;
  }

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

  await openRdpSession(node);
}

async function openRdpSession(node: ConnectionNode): Promise<void> {
  if (node.kind !== 'rdp' || !workspaceEl) {
    throw new Error('cannot open non-RDP node');
  }

  let tabKey = `pending:${crypto.randomUUID()}`;
  const root = document.createElement('div');
  root.className = 'rdp-host-container';
  root.style.display = 'none';
  workspaceEl.appendChild(root);

  const host = document.createElement('div');
  host.className = 'rdp-host-surface';
  root.appendChild(host);

  const overlay = document.createElement('div');
  overlay.className = 'conn-overlay connecting';
  overlay.innerHTML = `
    <div class="conn-loader" aria-hidden="true"></div>
    <p class="conn-overlay-text" aria-live="polite">Connecting...</p>
  `;
  root.appendChild(overlay);

  const tab: RdpSessionTab = {
    kind: 'rdp',
    connectionId: node.id,
    sessionId: null,
    baseTitle: node.name,
    title: nextTabTitle(node.name),
    root,
    host,
    overlay,
    rdpState: 'connecting',
    cleanup: []
  };

  tabs.set(tabKey, tab);
  activateTab(tabKey);

  let sessionId: string | null = null;
  const cleanup: Array<() => void> = [];
  tab.cleanup = cleanup;

  const runCleanup = (): void => {
    for (const fn of cleanup.splice(0)) fn();
  };

  try {
    const initialViewport = getRdpViewport(host);
    if (!initialViewport) {
      throw new Error('RDP host container has no visible size');
    }

    sessionId = await api.openRdp(node.id, initialViewport);
    if (!tabs.has(tabKey)) {
      await api.closeRdp(sessionId).catch(() => undefined);
      return;
    }

    const sid = sessionId;
    const unlistenState = await api.listenRdpState(sid, (event) => {
      const current = tabs.get(tabKey);
      if (!current || current.kind !== 'rdp') return;
      applyRdpLifecycleEvent(current, event);
    });
    cleanup.push(unlistenState);

    const unlistenExit = await api.listenRdpExit(sid, (_reason) => {
      void closeTab(tabKey);
    });
    cleanup.push(unlistenExit);

    const current = tabs.get(tabKey);
    if (!current || current.kind !== 'rdp') {
      runCleanup();
      await api.closeRdp(sessionId).catch(() => undefined);
      return;
    }

    current.sessionId = sessionId;

    if (tabKey !== sessionId) {
      tabs.delete(tabKey);
      tabs.set(sessionId, current);
      if (activeTab === tabKey) {
        activeTab = sessionId;
      }
      tabKey = sessionId;
      renderTabs();
    }

    void syncRdpTabVisibility();
    scheduleActiveTabResize();
  } catch (error) {
    runCleanup();
    if (sessionId) {
      await api.closeRdp(sessionId).catch(() => undefined);
    }
    const failedTab = tabs.get(tabKey);
    if (failedTab) {
      failedTab.root.remove();
      tabs.delete(tabKey);
    }
    finalizeTabRemoval(tabKey);
    throw error;
  }
}

/* ── RDP Helpers ──────────────────────────────────── */

function getRdpViewport(element: HTMLElement): RdpViewport | null {
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height
  };
}

function setOverlayState(overlay: HTMLDivElement, state: 'connecting' | 'connected' | 'error', text: string): void {
  const textEl = overlay.querySelector<HTMLParagraphElement>('.conn-overlay-text');
  const loaderEl = overlay.querySelector<HTMLElement>('.conn-loader');

  if (state === 'connected') {
    overlay.classList.add('hidden');
    overlay.classList.remove('connecting', 'error');
    return;
  }

  overlay.classList.remove('hidden');
  overlay.classList.toggle('connecting', state === 'connecting');
  overlay.classList.toggle('error', state === 'error');
  if (textEl) {
    textEl.textContent = text;
  }
  if (loaderEl) {
    loaderEl.style.display = state === 'error' ? 'none' : '';
  }
}

function applyRdpLifecycleEvent(tab: RdpSessionTab, event: RdpLifecycleEvent): void {
  if (event.type === 'connecting') {
    tab.rdpState = 'connecting';
    setOverlayState(tab.overlay, 'connecting', 'Connecting...');
    return;
  }

  if (event.type === 'connected' || event.type === 'loginComplete') {
    tab.rdpState = 'connected';
    setOverlayState(tab.overlay, 'connected', '');
    return;
  }

  if (event.type === 'disconnected') {
    tab.rdpState = 'error';
    setOverlayState(tab.overlay, 'error', `Disconnected (${event.reason})`);
    return;
  }

  if (event.type === 'fatalError') {
    tab.rdpState = 'error';
    setOverlayState(tab.overlay, 'error', `RDP error (${event.errorCode})`);
    return;
  }

  tab.rdpState = 'error';
  const hresultText = event.hresult === null ? 'unknown HRESULT' : `HRESULT 0x${(event.hresult >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  setOverlayState(
    tab.overlay,
    'error',
    `RDP host init failed at ${event.stage} (${hresultText}): ${event.message}`
  );
}

async function syncRdpTabVisibility(): Promise<void> {
  const operations: Promise<unknown>[] = [];

  for (const [tabKey, tab] of tabs.entries()) {
    if (tab.kind !== 'rdp' || !tab.sessionId) continue;

    if (tabKey === activeTab && tab.root.style.display !== 'none') {
      const viewport = getRdpViewport(tab.host);
      if (!viewport) continue;
      operations.push(api.showRdp(tab.sessionId));
      operations.push(api.setRdpBounds(tab.sessionId, viewport));
    } else {
      operations.push(api.hideRdp(tab.sessionId));
    }
  }

  await Promise.allSettled(operations);
}

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

  for (const [tabKey, tab] of tabs.entries()) {
    const el = document.createElement('div');
    el.className = `tab${activeTab === tabKey ? ' active' : ''}`;

    const label = document.createElement('span');
    label.textContent =
      tab.kind === 'ssh' && tab.sshState === 'connecting'
        ? `${tab.title} [connecting]`
        : tab.kind === 'ssh' && tab.sshState === 'exited'
          ? `${tab.title} [exited]`
          : tab.title;
    el.appendChild(label);

    el.addEventListener('click', () => {
      activateTab(tabKey);
    });
    el.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void closeTab(tabKey);
      }
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, buildTabMenuActions(tabKey, tab));
    });

    if (tab.kind === 'ssh') {
      const sftpBtn = document.createElement('button');
      sftpBtn.className = 'tab-action-btn';
      sftpBtn.type = 'button';
      sftpBtn.title = 'Open SFTP';
      sftpBtn.setAttribute('aria-label', 'Open SFTP');
      sftpBtn.innerHTML = sftpIcon();
      sftpBtn.disabled = tab.sshState !== 'connected' || !tab.sessionId;
      sftpBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void openSftpModalForTab(tabKey);
      });
      el.appendChild(sftpBtn);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '\u00d7';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void closeTab(tabKey);
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
        void closeTab(tabKey);
      }
    });

    el.appendChild(close);
    tabsEl.appendChild(el);
  }
}

function activateTab(tabKey: string): void {
  activeTab = tabKey;

  for (const [key, tab] of tabs.entries()) {
    tab.root.style.display = key === tabKey ? 'block' : 'none';
  }

  void syncRdpTabVisibility();
  scheduleActiveTabResize();
  renderTabs();
}

async function closeTab(tabKey: string): Promise<void> {
  const tab = tabs.get(tabKey);
  if (!tab) return;

  if (activeSftpModal?.tabKey === tabKey) {
    hideModal();
  }

  if (tab.kind === 'ssh') {
    if (tab.sessionId) {
      await api.closeSsh(tab.sessionId).catch(() => undefined);
    }
    tab.terminal.dispose();
  } else if (tab.sessionId) {
    await api.closeRdp(tab.sessionId).catch(() => undefined);
  }
  for (const fn of tab.cleanup) fn();
  tab.root.remove();
  tabs.delete(tabKey);
  finalizeTabRemoval(tabKey);
}

function finalizeTabRemoval(removedTabKey: string): void {
  if (activeTab === removedTabKey) {
    activeTab = tabs.keys().next().value ?? null;
    if (activeTab) {
      activateTab(activeTab);
      return;
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
  if (tab.kind === 'ssh') {
    if (tab.sshState !== 'connected' || !tab.sessionId) return;
    tab.fitAddon.fit();
    const cols = Math.max(1, tab.terminal.cols);
    const rows = Math.max(1, tab.terminal.rows);
    void api.resizeSsh(tab.sessionId, cols, rows);
    return;
  }

  if (!tab.sessionId) return;
  const viewport = getRdpViewport(tab.host);
  if (!viewport) return;
  void api.setRdpBounds(tab.sessionId, viewport);
}

function scheduleActiveTabResize(): void {
  if (pendingTabResizeFrame !== null) return;

  pendingTabResizeFrame = window.requestAnimationFrame(() => {
    pendingTabResizeFrame = null;
    resizeActiveTab();
  });
}

function toggleFileMenu(): void {
  const nextOpen = !fileMenuOpen;
  if (nextOpen && settingsMenuOpen) {
    setSettingsMenuOpen(false);
  }
  setFileMenuOpen(nextOpen);
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

function toggleSettingsMenu(): void {
  const nextOpen = !settingsMenuOpen;
  if (nextOpen && fileMenuOpen) {
    setFileMenuOpen(false);
  }
  setSettingsMenuOpen(nextOpen);
}

/* ── SFTP Modal ───────────────────────────────────── */

function createSftpPane(side: FilePaneSide): SftpPaneState {
  return {
    side,
    cwd: '',
    entries: [],
    selectedPath: null,
    selectedKind: null,
    loading: false,
    rootEl: null,
    pathEl: null,
    listEl: null
  };
}

async function openSftpModalForTab(tabKey: string): Promise<void> {
  const tab = tabs.get(tabKey);
  if (!tab || tab.kind !== 'ssh' || !tab.sessionId) {
    writeStatus('SSH tab is no longer available');
    return;
  }
  if (tab.sshState !== 'connected') {
    writeStatus('SFTP is available only while the SSH tab is connected');
    return;
  }

  if (activeSftpModal?.tabKey === tabKey) {
    return;
  }

  if (activeSftpModal) {
    hideModal();
  }

  const opened = await api.openSftp(tab.sessionId);

  const state: SftpModalState = {
    tabKey,
    sshSessionId: tab.sessionId,
    connectionName: tab.title,
    sftpSessionId: opened.sftpSessionId,
    closing: false,
    activePane: 'remote',
    local: createSftpPane('local'),
    remote: createSftpPane('remote'),
    card: null,
    statusEl: null
  };

  showModal(`SFTP - ${tab.title}`, (card) => {
    activeSftpModal = state;
    state.card = card;
    card.classList.add('sftp-modal');

    const toolbar = document.createElement('div');
    toolbar.className = 'sftp-toolbar';

    const transferRow = document.createElement('div');
    transferRow.className = 'sftp-transfer-row';

    const layout = document.createElement('div');
    layout.className = 'sftp-layout';

    const footer = document.createElement('div');
    footer.className = 'sftp-footer';

    const statusEl = document.createElement('p');
    statusEl.className = 'sftp-status';
    state.statusEl = statusEl;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', hideModal);

    footer.append(statusEl, closeBtn);

    const actionButtons: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'New File', icon: sftpToolbarSvg('file-plus'), onClick: () => void sftpCreateItem(state, 'file') },
      { label: 'New Folder', icon: sftpToolbarSvg('folder-plus'), onClick: () => void sftpCreateItem(state, 'folder') },
      { label: 'Rename', icon: sftpToolbarSvg('rename'), onClick: () => void sftpRenameSelected(state) },
      { label: 'Delete', icon: sftpToolbarSvg('delete'), onClick: () => void sftpDeleteSelected(state) }
    ];

    for (const action of actionButtons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sftp-toolbar-btn';
      btn.innerHTML = `${action.icon}<span>${escapeHtml(action.label)}</span>`;
      btn.addEventListener('click', action.onClick);
      toolbar.appendChild(btn);
    }

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn';
    uploadBtn.innerHTML = `${sftpToolbarSvg('upload')}<span>Upload -></span>`;
    uploadBtn.addEventListener('click', () => void sftpTransfer(state, 'upload'));

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn';
    downloadBtn.innerHTML = `${sftpToolbarSvg('download')}<span>&larr; Download</span>`;
    downloadBtn.addEventListener('click', () => void sftpTransfer(state, 'download'));

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn';
    refreshBtn.innerHTML = `${sftpToolbarSvg('refresh')}<span>Refresh</span>`;
    refreshBtn.addEventListener('click', () => void sftpRefreshBothPanes(state));

    transferRow.append(uploadBtn, downloadBtn, refreshBtn);

    layout.append(
      buildSftpPaneUi(state, state.local, 'My PC'),
      buildSftpPaneUi(state, state.remote, state.connectionName)
    );

    card.append(toolbar, transferRow, layout, footer);

    void sftpRefreshBothPanes(state, '', opened.remoteCwd);
  });

  modalOnHide = () => {
    if (activeSftpModal !== state) return;
    if (state.closing) return;
    state.closing = true;
    const sshSessionId = state.sshSessionId;
    const sftpSessionId = state.sftpSessionId;
    activeSftpModal = null;
    if (sftpSessionId) {
      void api.closeSftp(sshSessionId, sftpSessionId).catch(() => undefined);
      state.sftpSessionId = null;
    }
  };
}

function buildSftpPaneUi(state: SftpModalState, pane: SftpPaneState, title: string): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'sftp-pane';
  root.dataset.side = pane.side;
  root.addEventListener('click', () => {
    sftpSetActivePane(state, pane.side);
  });

  const header = document.createElement('div');
  header.className = 'sftp-pane-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'sftp-pane-title';
  titleEl.textContent = title;

  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'btn btn-sm btn-ghost sftp-pane-up';
  upBtn.innerHTML = `${sftpToolbarSvg('up')}<span>Up</span>`;
  upBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void sftpNavigateParent(state, pane.side);
  });

  header.append(titleEl, upBtn);

  const pathRow = document.createElement('div');
  pathRow.className = 'sftp-path-row';

  const pathEl = document.createElement('input');
  pathEl.type = 'text';
  pathEl.className = 'sftp-path-input';
  pathEl.readOnly = true;
  pathEl.value = '';

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'btn btn-sm';
  goBtn.textContent = 'Open';
  goBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextPath = pathEl.value.trim();
    if (!nextPath) return;
    void sftpLoadPane(state, pane.side, nextPath);
  });

  pathEl.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    pathEl.readOnly = false;
    pathEl.focus();
    pathEl.select();
  });
  pathEl.addEventListener('blur', () => {
    pathEl.readOnly = true;
    pathEl.value = pane.cwd;
  });
  pathEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      pathEl.readOnly = true;
      void sftpLoadPane(state, pane.side, pathEl.value.trim());
    } else if (event.key === 'Escape') {
      pathEl.readOnly = true;
      pathEl.value = pane.cwd;
      pathEl.blur();
    }
  });

  pathRow.append(pathEl, goBtn);

  const listEl = document.createElement('div');
  listEl.className = 'sftp-file-list';

  root.append(header, pathRow, listEl);

  pane.rootEl = root;
  pane.pathEl = pathEl;
  pane.listEl = listEl;

  sftpSetActivePane(state, state.activePane);
  sftpRenderPane(state, pane);

  return root;
}

function sftpSetStatus(state: SftpModalState, message: string, kind: 'info' | 'error' = 'info'): void {
  if (activeSftpModal !== state || !state.statusEl) return;
  state.statusEl.textContent = message;
  state.statusEl.classList.toggle('error', kind === 'error');
}

function sftpGetPane(state: SftpModalState, side: FilePaneSide): SftpPaneState {
  return side === 'local' ? state.local : state.remote;
}

function sftpSetActivePane(state: SftpModalState, side: FilePaneSide): void {
  state.activePane = side;
  state.local.rootEl?.classList.toggle('active', side === 'local');
  state.remote.rootEl?.classList.toggle('active', side === 'remote');
}

function sftpSelectPaneEntry(state: SftpModalState, side: FilePaneSide, entry: FileEntry | null): void {
  const pane = sftpGetPane(state, side);
  sftpSetActivePane(state, side);
  pane.selectedPath = entry?.path ?? null;
  pane.selectedKind = entry?.kind ?? null;
  sftpRenderPane(state, pane);
}

function sftpRenderPane(state: SftpModalState, pane: SftpPaneState): void {
  if (!pane.listEl) return;

  if (pane.pathEl) {
    pane.pathEl.value = pane.cwd;
  }

  pane.listEl.replaceChildren();
  const frag = document.createDocumentFragment();

  if (pane.loading) {
    const loading = document.createElement('div');
    loading.className = 'sftp-file-row sftp-file-row-empty';
    loading.textContent = 'Loading...';
    frag.appendChild(loading);
    pane.listEl.appendChild(frag);
    return;
  }

  const parentPath = pane.side === 'remote' ? sftpRemoteParentPath(pane.cwd) : sftpLocalParentPath(pane.cwd);
  if (parentPath) {
    const parentRow = document.createElement('button');
    parentRow.type = 'button';
    parentRow.className = 'sftp-file-row parent';
    parentRow.innerHTML = `<span class=\"sftp-file-icon\">${sftpEntryIcon('dir')}</span><span class=\"sftp-file-name\">..</span>`;
    parentRow.addEventListener('click', () => {
      sftpSetActivePane(state, pane.side);
    });
    parentRow.addEventListener('dblclick', () => {
      void sftpLoadPane(state, pane.side, parentPath);
    });
    frag.appendChild(parentRow);
  }

  if (pane.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sftp-file-row sftp-file-row-empty';
    empty.textContent = 'Empty';
    frag.appendChild(empty);
  } else {
    for (const entry of pane.entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `sftp-file-row${pane.selectedPath === entry.path ? ' selected' : ''}`;

      const icon = document.createElement('span');
      icon.className = 'sftp-file-icon';
      icon.innerHTML = sftpEntryIcon(entry.kind);

      const name = document.createElement('span');
      name.className = 'sftp-file-name';
      name.textContent = entry.name;

      const meta = document.createElement('span');
      meta.className = 'sftp-file-meta';
      meta.textContent =
        entry.kind === 'dir'
          ? 'folder'
          : entry.size != null
            ? `${entry.size} B`
            : entry.kind;

      row.append(icon, name, meta);
      row.addEventListener('click', () => sftpSelectPaneEntry(state, pane.side, entry));
      row.addEventListener('dblclick', () => {
        sftpSelectPaneEntry(state, pane.side, entry);
        if (entry.kind === 'dir') {
          void sftpLoadPane(state, pane.side, entry.path);
        }
      });

      frag.appendChild(row);
    }
  }

  pane.listEl.appendChild(frag);
}

async function sftpRefreshBothPanes(
  state: SftpModalState,
  localPath = state.local.cwd || '',
  remotePath = state.remote.cwd || '.'
): Promise<void> {
  await Promise.all([sftpLoadPane(state, 'local', localPath), sftpLoadPane(state, 'remote', remotePath)]);
}

async function sftpLoadPane(state: SftpModalState, side: FilePaneSide, path: string): Promise<void> {
  if (activeSftpModal !== state || state.closing) return;
  const pane = sftpGetPane(state, side);
  pane.loading = true;
  sftpRenderPane(state, pane);

  try {
    let result: FileListResult;
    if (side === 'local') {
      result = await api.localFsList(path);
    } else {
      if (!state.sftpSessionId) throw new Error('SFTP session is closed');
      result = await api.listSftp({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId,
        path
      });
    }

    if (activeSftpModal !== state || state.closing) return;
    pane.cwd = result.cwd;
    pane.entries = result.entries;
    pane.loading = false;

    if (pane.selectedPath && !pane.entries.some((entry) => entry.path === pane.selectedPath)) {
      pane.selectedPath = null;
      pane.selectedKind = null;
    }

    sftpRenderPane(state, pane);
  } catch (error) {
    pane.loading = false;
    sftpRenderPane(state, pane);
    sftpSetStatus(state, formatError(error), 'error');
  }
}

async function sftpNavigateParent(state: SftpModalState, side: FilePaneSide): Promise<void> {
  const pane = sftpGetPane(state, side);
  const parent = side === 'remote' ? sftpRemoteParentPath(pane.cwd) : sftpLocalParentPath(pane.cwd);
  if (!parent) return;
  await sftpLoadPane(state, side, parent);
}

async function sftpCreateItem(state: SftpModalState, kind: 'file' | 'folder'): Promise<void> {
  const pane = sftpGetPane(state, state.activePane);
  if (!pane.cwd) return;
  const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name', '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    sftpSetStatus(state, 'Name cannot contain path separators', 'error');
    return;
  }

  const fullPath =
    pane.side === 'local' ? sftpLocalJoinPath(pane.cwd, trimmed) : sftpRemoteJoinPath(pane.cwd, trimmed);

  try {
    if (pane.side === 'local') {
      if (kind === 'file') {
        await api.localFsNewFile(fullPath);
      } else {
        await api.localFsNewFolder(fullPath);
      }
    } else {
      if (!state.sftpSessionId) throw new Error('SFTP session is closed');
      const request = {
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId,
        path: fullPath
      };
      if (kind === 'file') {
        await api.sftpNewFile(request);
      } else {
        await api.sftpNewFolder(request);
      }
    }
    sftpSetStatus(state, `${kind === 'file' ? 'File' : 'Folder'} created`);
    await sftpLoadPane(state, pane.side, pane.cwd);
  } catch (error) {
    sftpSetStatus(state, formatError(error), 'error');
  }
}

async function sftpRenameSelected(state: SftpModalState): Promise<void> {
  const pane = sftpGetPane(state, state.activePane);
  const entry = pane.entries.find((item) => item.path === pane.selectedPath);
  if (!entry) {
    sftpSetStatus(state, 'Select a file or folder to rename', 'error');
    return;
  }
  const nextName = window.prompt('Rename to', entry.name);
  if (nextName == null) return;
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === entry.name) return;
  if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    sftpSetStatus(state, 'Name cannot contain path separators', 'error');
    return;
  }

  const parent = pane.side === 'local' ? sftpLocalParentPath(entry.path) : sftpRemoteParentPath(entry.path);
  const newPath =
    pane.side === 'local'
      ? sftpLocalJoinPath(parent ?? pane.cwd, trimmed)
      : sftpRemoteJoinPath(parent ?? pane.cwd, trimmed);

  try {
    if (pane.side === 'local') {
      await api.localFsRename(entry.path, newPath);
    } else {
      if (!state.sftpSessionId) throw new Error('SFTP session is closed');
      await api.sftpRename({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId,
        oldPath: entry.path,
        newPath
      });
    }
    sftpSetStatus(state, 'Renamed');
    await sftpLoadPane(state, pane.side, pane.cwd);
  } catch (error) {
    sftpSetStatus(state, formatError(error), 'error');
  }
}

async function sftpDeleteSelected(state: SftpModalState): Promise<void> {
  const pane = sftpGetPane(state, state.activePane);
  const entry = pane.entries.find((item) => item.path === pane.selectedPath);
  if (!entry) {
    sftpSetStatus(state, 'Select a file or folder to delete', 'error');
    return;
  }

  const confirmed = window.confirm(`Delete ${entry.kind === 'dir' ? 'folder' : 'file'} "${entry.name}"?`);
  if (!confirmed) return;

  try {
    if (pane.side === 'local') {
      await api.localFsDelete(entry.path, entry.kind === 'dir');
    } else {
      if (!state.sftpSessionId) throw new Error('SFTP session is closed');
      await api.sftpDelete({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId,
        path: entry.path,
        isDir: entry.kind === 'dir'
      });
    }
    sftpSetStatus(state, 'Deleted');
    await sftpLoadPane(state, pane.side, pane.cwd);
  } catch (error) {
    sftpSetStatus(state, formatError(error), 'error');
  }
}

async function sftpTransfer(state: SftpModalState, direction: 'upload' | 'download'): Promise<void> {
  if (!state.sftpSessionId) {
    sftpSetStatus(state, 'SFTP session is closed', 'error');
    return;
  }

  const sourcePane = direction === 'upload' ? state.local : state.remote;
  const targetPane = direction === 'upload' ? state.remote : state.local;
  const sourceEntry = sourcePane.entries.find((item) => item.path === sourcePane.selectedPath);

  if (!sourceEntry) {
    sftpSetStatus(state, `Select a ${direction === 'upload' ? 'local' : 'remote'} file first`, 'error');
    return;
  }
  if (sourceEntry.kind !== 'file') {
    sftpSetStatus(state, 'Directory transfer is not supported in v1 (file-only)', 'error');
    return;
  }
  if (!targetPane.cwd) {
    sftpSetStatus(state, 'Target folder is unavailable', 'error');
    return;
  }

  const fileName = sftpBaseName(sourceEntry.path);
  const localPath =
    direction === 'upload' ? sourceEntry.path : sftpLocalJoinPath(targetPane.cwd, fileName);
  const remotePath =
    direction === 'upload' ? sftpRemoteJoinPath(targetPane.cwd, fileName) : sourceEntry.path;

  const runTransfer = async (overwrite: boolean): Promise<void> => {
    if (direction === 'upload') {
      await api.sftpUploadFile({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId!,
        localPath,
        remotePath,
        overwrite
      });
    } else {
      await api.sftpDownloadFile({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId!,
        localPath,
        remotePath,
        overwrite
      });
    }
  };

  try {
    await runTransfer(false);
  } catch (error) {
    const message = formatError(error);
    if (message.toLowerCase().includes('already exists')) {
      const ok = window.confirm(`Overwrite existing ${direction === 'upload' ? 'remote' : 'local'} file "${fileName}"?`);
      if (!ok) return;
      try {
        await runTransfer(true);
      } catch (retryError) {
        sftpSetStatus(state, formatError(retryError), 'error');
        return;
      }
    } else {
      sftpSetStatus(state, message, 'error');
      return;
    }
  }

  sftpSetStatus(state, direction === 'upload' ? 'Upload complete' : 'Download complete');
  await sftpRefreshBothPanes(state, state.local.cwd, state.remote.cwd);
}

function sftpRemoteJoinPath(base: string, name: string): string {
  if (!base || base === '.') return name;
  if (base === '/') return `/${name}`;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function sftpRemoteParentPath(path: string): string | null {
  if (!path || path === '.' || path === '/') return null;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return null;
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

function sftpLocalJoinPath(base: string, name: string): string {
  if (!base) return name;
  if (/[\\/]$/.test(base)) return `${base}${name}`;
  if (/^[A-Za-z]:$/.test(base)) return `${base}\\${name}`;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${sep}${name}`;
}

function sftpLocalParentPath(path: string): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  if (/^[A-Za-z]:$/.test(trimmed)) return null;
  if (/^[A-Za-z]:\\$/.test(path)) return null;
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (idx < 0) return null;
  if (idx === 0) return '/';
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || null;
}

function sftpBaseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function sftpEntryIcon(kind: FileEntryKind): string {
  if (kind === 'dir') {
    return '<svg viewBox="0 0 16 16" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"><path d=\"M1.5 4.5h5l1.2 1.2H14.5v7.8a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z\"/><path d=\"M1.5 4.5v-1A1 1 0 0 1 2.5 2.5h3.3l1.2 1.2H8.5\"/></svg>';
  }
  if (kind === 'symlink') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"><path d=\"M6 5.5 4.6 4.1a2.2 2.2 0 1 0-3.1 3.1L3 8.7\"/><path d=\"M10 10.5l1.4 1.4a2.2 2.2 0 0 0 3.1-3.1L13 7.3\"/><path d=\"M5.4 10.6 10.6 5.4\"/></svg>';
  }
  return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"><path d=\"M4 1.8h5l3 3V14a.7.7 0 0 1-.7.7H4.7A.7.7 0 0 1 4 14z\"/><path d=\"M9 1.8V5h3\"/></svg>';
}

function sftpToolbarSvg(kind: 'file-plus' | 'folder-plus' | 'rename' | 'delete' | 'upload' | 'download' | 'refresh' | 'up'): string {
  if (kind === 'file-plus') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"><path d=\"M3.8 1.8h5l3 3V14a.7.7 0 0 1-.7.7H4.5a.7.7 0 0 1-.7-.7z\"/><path d=\"M8.8 1.8V5h3\"/><path d=\"M6 9h4M8 7v4\"/></svg>';
  }
  if (kind === 'folder-plus') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"><path d=\"M1.5 5h13v7.8a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z\"/><path d=\"M1.5 5V3.6a1 1 0 0 1 1-1h3.2L7 4h6.5\"/><path d=\"M8 7.3v4M6 9.3h4\"/></svg>';
  }
  if (kind === 'rename') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2.2 11.8V13.8h2l7.2-7.2-2-2z\"/><path d=\"M8.3 3.6 10.4 1.5a1.2 1.2 0 0 1 1.7 0l1.4 1.4a1.2 1.2 0 0 1 0 1.7l-2.1 2.1\"/></svg>';
  }
  if (kind === 'delete') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"><path d=\"M2.5 4.5h11\"/><path d=\"M6 2.5h4\"/><path d=\"M4 4.5l.6 8.2a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.2\"/><path d=\"M6.5 7v4.5M9.5 7v4.5\"/></svg>';
  }
  if (kind === 'upload') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 11.8V3.2\"/><path d=\"M5.2 6 8 3.2 10.8 6\"/><path d=\"M2.2 12.8h11.6\"/></svg>';
  }
  if (kind === 'download') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 3.2v8.6\"/><path d=\"M5.2 9 8 11.8 10.8 9\"/><path d=\"M2.2 12.8h11.6\"/></svg>';
  }
  if (kind === 'up') {
    return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 13V3\"/><path d=\"M4.8 6.2 8 3l3.2 3.2\"/></svg>';
  }
  return '<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 8a5 5 0 1 1-1.5-3.6\"/><path d=\"M13 3.5v3.7H9.3\"/></svg>';
}

function setSettingsMenuOpen(nextOpen: boolean): void {
  settingsMenuOpen = nextOpen;
  if (settingsMenuEl) {
    settingsMenuEl.classList.toggle('visible', nextOpen);
    settingsMenuEl.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  }
  if (settingsMenuTriggerEl) {
    settingsMenuTriggerEl.classList.toggle('open', nextOpen);
    settingsMenuTriggerEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
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

function clearPingStatus(): void {
  if (!pingStatusEl) return;
  pingStatusEl.classList.remove('is-reachable', 'is-unreachable');
  pingStatusEl.replaceChildren();
}

function writePingStatus(connectionName: string, reachable: boolean): void {
  if (!pingStatusEl) return;

  pingStatusEl.classList.remove('is-reachable', 'is-unreachable');
  pingStatusEl.classList.add(reachable ? 'is-reachable' : 'is-unreachable');

  const host = document.createElement('span');
  host.className = 'ping-status-host';
  host.textContent = connectionName;

  const outcome = document.createElement('span');
  outcome.className = 'ping-status-outcome';
  outcome.textContent = reachable ? 'REACHABLE' : 'UNREACHABLE';

  pingStatusEl.replaceChildren(host, outcome);
}

async function pingSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
  const requestId = ++pingRequestSeq;

  try {
    const result = await api.pingConnectionIcmp(nodeId);
    if (requestId !== pingRequestSeq) return;
    if (selectedNodeId !== nodeId) return;
    writePingStatus(connectionName, result.reachable);
  } catch (error) {
    if (requestId !== pingRequestSeq) return;
    if (selectedNodeId !== nodeId) return;
    writeStatus(formatError(error));
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
  modalOnHide = null;
  activeSftpModal = null;
  fileMenuTriggerEl = null;
  fileMenuEl = null;
  settingsMenuTriggerEl = null;
  settingsMenuEl = null;
  vaultLockEl = null;
  appVersionEl = null;
  vaultUnlocked = false;
  fileMenuOpen = false;
  settingsMenuOpen = false;
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
