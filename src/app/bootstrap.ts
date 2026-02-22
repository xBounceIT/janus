import { FitAddon } from '@xterm/addon-fit';
import cargoToml from '../../src-tauri/Cargo.toml?raw';
import { Terminal } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from '../api';
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
} from '../types';
import {
  disconnectIcon,
  duplicateIcon,
  faIcon,
  reconnectIcon,
  sftpEntryIcon,
  sftpIcon,
  sftpToolbarSvg,
  svgIcon,
  vaultLockIconSvg,
} from './icons';
import type {
  FilePaneSide,
  PreferencesSectionId,
  PreferencesSectionDefinition,
  RdpSessionTab,
  SessionTab,
  SftpPaneState,
  SftpModalState,
  SshSessionTab,
} from './types';
import {
  applyInputPrivacyAttributes,
  escapeAttr,
  escapeHtml,
  formatError,
  getModalOptional,
  getModalValue,
  must,
  parseCargoPackageVersion,
  wireModalEnterKey,
} from './utils';
import { createSftpController } from './sftp';
import { createTabsController } from './tabs';
import { createContextMenuController, type MenuAction } from './context-menu';
import { createModalController } from './modal';
import { createStatusController } from './status';
import { createTreeController } from './tree';

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
    icon: faIcon('fa-solid fa-display'),
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
    icon: faIcon('fa-solid fa-shield-halved'),
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
    icon: faIcon('fa-solid fa-gear'),
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

const modalController = createModalController({
  getModalOverlayEl: () => modalOverlayEl,
  getModalOnHide: () => modalOnHide,
  setModalOnHide: (handler) => {
    modalOnHide = handler;
  },
  applyInputPrivacyAttributes,
});

const contextMenuController = createContextMenuController({
  getContextMenuEl: () => contextMenuEl,
});

const statusController = createStatusController({
  getStatusEl: () => statusEl,
  getPingStatusEl: () => pingStatusEl,
  pingConnectionIcmp: api.pingConnectionIcmp,
  formatError,
  getSelectedNodeId: () => selectedNodeId,
  nextPingRequestSeq: () => {
    pingRequestSeq += 1;
    return pingRequestSeq;
  },
  getPingRequestSeq: () => pingRequestSeq,
});

const sftpController = createSftpController({
  tabs,
  api,
  showModal,
  hideModal,
  setModalOnHide: (handler) => {
    modalOnHide = handler;
  },
  getActiveSftpModal: () => activeSftpModal,
  setActiveSftpModal: (state) => {
    activeSftpModal = state;
  },
  writeStatus,
  formatError,
  escapeHtml,
  sftpToolbarSvg,
  sftpEntryIcon,
});

const tabsController = createTabsController({
  tabs,
  getTabsEl: () => tabsEl,
  getActiveTab: () => activeTab,
  setActiveTab: (tabKey) => {
    activeTab = tabKey;
  },
  getActiveSftpModalTabKey: () => activeSftpModal?.tabKey ?? null,
  hideModal,
  closeSsh: api.closeSsh,
  closeRdp: api.closeRdp,
  resizeSsh: api.resizeSsh,
  setRdpBounds: api.setRdpBounds,
  getRdpViewport,
  syncRdpTabVisibility,
  showContextMenu: (x, y, actions) => {
    showContextMenu(x, y, actions as MenuAction[]);
  },
  buildTabMenuActions: (tabKey, tab) => buildTabMenuActions(tabKey, tab),
  openSftpModalForTab,
  faIcon,
  sftpIcon,
  getPendingTabResizeFrame: () => pendingTabResizeFrame,
  setPendingTabResizeFrame: (frame) => {
    pendingTabResizeFrame = frame;
  },
});

const treeController = createTreeController({
  listTree: api.listTree,
  getTreeEl: () => treeEl,
  getNodes: () => nodes,
  setNodes: (nextNodes) => {
    nodes = nextNodes;
  },
  expandedFolders,
  getSelectedNodeId: () => selectedNodeId,
  setSelectedNodeId: (id) => {
    selectedNodeId = id;
  },
  bumpPingRequestSeq: () => {
    pingRequestSeq += 1;
  },
  clearPingStatus,
  pingSelectedConnection,
  svgIcon,
  openConnectionNode: (node) => {
    if (node.kind === 'ssh') {
      void openSshWithStatus(node);
    } else if (node.kind === 'rdp') {
      void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
    }
  },
  showContextMenu,
  buildFolderMenuActions,
  buildConnectionMenuActions,
});

/* ── Boot ─────────────────────────────────────────── */

let bootstrapped = false;

export function bootApp(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  void api.listenErrors((message) => writeStatus(message));

  window.addEventListener('resize', () => {
    scheduleActiveTabResize();
  });

  void boot();
}

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
            <button class="menu-item" id="file-import" role="menuitem"><i class="fa-solid fa-file-import" aria-hidden="true"></i> Import</button>
            <button class="menu-item" id="file-export" role="menuitem"><i class="fa-solid fa-file-export" aria-hidden="true"></i> Export</button>
          </div>
        </div>
        <div class="menu-root">
          <button class="menu-trigger" id="settings-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="settings-menu">Settings</button>
          <div id="settings-menu" class="menu-panel" role="menu" aria-hidden="true">
            <button class="menu-item" id="settings-preferences" role="menuitem"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Preferences</button>
            <button class="menu-item" id="settings-about" role="menuitem"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> About</button>
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
  await treeController.refreshTree();
}

function renderTree(): void {
  treeController.renderTree();
}

/* ── Context Menu ─────────────────────────────────── */

function buildFolderMenuActions(node: ConnectionNode | null, isRoot: boolean): MenuAction[] {
  const parentId = isRoot ? null : node?.id ?? null;
  const items: MenuAction[] = [
    { label: 'New Folder', icon: faIcon('fa-solid fa-folder-plus'), action: () => showFolderModal(parentId) },
    { label: 'New connection', icon: faIcon('fa-solid fa-plus'), action: () => showConnectionModal('ssh', parentId) }
  ];

  if (!isRoot && node) {
    items.push('separator');
    items.push({ label: 'Rename', icon: faIcon('fa-solid fa-i-cursor'), action: () => showRenameModal(node) });
    items.push({ label: 'Delete', icon: faIcon('fa-solid fa-trash'), danger: true, action: () => showDeleteModal(node) });
  }

  return items;
}

function buildConnectionMenuActions(node: ConnectionNode): MenuAction[] {
  const items: MenuAction[] = [];

  if (node.kind === 'ssh') {
    items.push({
      label: 'Open SSH',
      icon: faIcon('fa-solid fa-terminal'),
      action: () => {
        void openSshWithStatus(node);
      }
    });
  } else if (node.kind === 'rdp') {
    items.push({
      label: 'Open RDP',
      icon: faIcon('fa-solid fa-desktop'),
      action: () => {
        void withStatus(`RDP ready: ${node.name}`, () => openRdp(node));
      }
    });
  }

  items.push('separator');
  items.push({ label: 'Edit', icon: faIcon('fa-solid fa-pen-to-square'), action: () => showEditConnectionModal(node) });
  items.push({ label: 'Rename', icon: faIcon('fa-solid fa-i-cursor'), action: () => showRenameModal(node) });
  items.push('separator');
  items.push({ label: 'Delete', icon: faIcon('fa-solid fa-trash'), danger: true, action: () => showDeleteModal(node) });

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
  contextMenuController.showContextMenu(x, y, actions);
}

function hideContextMenu(): void {
  contextMenuController.hideContextMenu();
}

function wireContextMenuDismiss(): void {
  contextMenuController.wireContextMenuDismiss();
}

/* ── Modal System ─────────────────────────────────── */

function showModal(title: string, buildContent: (card: HTMLDivElement) => void): void {
  modalController.showModal(title, buildContent);
}

function hideModal(): void {
  modalController.hideModal();
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
  return tabsController.nextTabTitle(baseTitle);
}

/* ── Tab Management ───────────────────────────────── */

function renderTabs(): void {
  tabsController.renderTabs();
}

function activateTab(tabKey: string): void {
  tabsController.activateTab(tabKey);
}

async function closeTab(tabKey: string): Promise<void> {
  await tabsController.closeTab(tabKey);
}

function finalizeTabRemoval(removedTabKey: string): void {
  tabsController.finalizeTabRemoval(removedTabKey);
}

function fitAndResizeTab(tab: SessionTab): void {
  tabsController.fitAndResizeTab(tab);
}

function scheduleActiveTabResize(): void {
  tabsController.scheduleActiveTabResize();
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

async function openSftpModalForTab(tabKey: string): Promise<void> {
  await sftpController.openSftpModalForTab(tabKey);
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

function loadAppVersion(): void {
  const target = appVersionEl;
  if (!target) return;
  target.textContent = APP_VERSION ? `v${APP_VERSION}` : 'v?';
}

/* ── Utility ──────────────────────────────────────── */

function writeStatus(message: string): void {
  statusController.writeStatus(message);
}

function clearPingStatus(): void {
  statusController.clearPingStatus();
}

function writePingStatus(connectionName: string, reachable: boolean): void {
  statusController.writePingStatus(connectionName, reachable);
}

async function pingSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
  await statusController.pingSelectedConnection(nodeId, connectionName);
}

async function withStatus(message: string, fn: () => Promise<unknown>): Promise<void> {
  await statusController.withStatus(message, fn);
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
