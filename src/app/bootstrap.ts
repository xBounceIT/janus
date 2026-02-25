import { FitAddon } from '@xterm/addon-fit';
import cargoToml from '../../src-tauri/Cargo.toml?raw';
import { Terminal } from '@xterm/xterm';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from '../api';
import type {
  ConnectionNode,
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
import { createConnectionModalController } from './connection-modal';
import { createProtocolsController } from './protocols';
import { createCrudModalController } from './crud-modals';
import { createShellController } from './shell';

/* ── DOM refs ─────────────────────────────────────── */

const app = must<HTMLDivElement>('#app');

let statusEl: HTMLElement | null = null;
let connectionCheckStatusEl: HTMLElement | null = null;
let treeEl: HTMLDivElement | null = null;
let treeSearchEl: HTMLInputElement | null = null;
let treeExpandAllEl: HTMLButtonElement | null = null;
let treeCollapseAllEl: HTMLButtonElement | null = null;
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
let pendingTabResizeFrame: number | null = null;
const SSH_OPEN_WATCHDOG_TIMEOUT_MS = 12_000;
const SSH_OPEN_WATCHDOG_ERROR = 'SSH open timed out waiting for backend response';

/* ── Tree state ───────────────────────────────────── */

const expandedFolders = new Set<string | null>([null]);
let selectedNodeId: string | null = null;
let connectionCheckRequestSeq = 0;
let treeSearchQuery = '';

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
  getConnectionCheckStatusEl: () => connectionCheckStatusEl,
  probeConnectionTcp: api.probeConnectionTcp,
  formatError,
  getSelectedNodeId: () => selectedNodeId,
  nextConnectionCheckRequestSeq: () => {
    connectionCheckRequestSeq += 1;
    return connectionCheckRequestSeq;
  },
  getConnectionCheckRequestSeq: () => connectionCheckRequestSeq,
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

const protocolsController = createProtocolsController({
  api,
  tabs,
  getWorkspaceEl: () => workspaceEl,
  getModalOverlayEl: () => modalOverlayEl,
  showModal,
  hideModal,
  writeStatus,
  formatError,
  escapeHtml,
  getActiveTab: () => activeTab,
  setActiveTab: (tabKey) => {
    activeTab = tabKey;
  },
  nextTabTitle,
  renderTabs,
  activateTab,
  finalizeTabRemoval,
  scheduleActiveTabResize,
  closeTab,
  sshOpenWatchdogTimeoutMs: SSH_OPEN_WATCHDOG_TIMEOUT_MS,
  sshOpenWatchdogError: SSH_OPEN_WATCHDOG_ERROR,
});

const treeController = createTreeController({
  listTree: api.listTree,
  moveNode: api.moveNode,
  getTreeEl: () => treeEl,
  getTreeSearchQuery: () => treeSearchQuery,
  getNodes: () => nodes,
  setNodes: (nextNodes) => {
    nodes = nextNodes;
  },
  expandedFolders,
  getSelectedNodeId: () => selectedNodeId,
  setSelectedNodeId: (id) => {
    selectedNodeId = id;
  },
  bumpConnectionCheckRequestSeq: () => {
    connectionCheckRequestSeq += 1;
  },
  clearConnectionCheckStatus,
  checkSelectedConnection,
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
  writeStatus,
  formatError,
});

const connectionModalController = createConnectionModalController({
  showModal,
  hideModal,
  wireModalEnterKey,
  applyInputPrivacyAttributes,
  escapeAttr,
  getModalValue,
  getModalOptional,
  upsertConnection: api.upsertConnection,
  expandedFolders,
  refreshTree,
  writeStatus,
  formatError,
});

const crudModalController = createCrudModalController({
  showModal,
  hideModal,
  wireModalEnterKey,
  escapeAttr,
  escapeHtml,
  upsertFolder: api.upsertFolder,
  upsertConnection: api.upsertConnection,
  deleteNode: api.deleteNode,
  importMremote: api.importMremote,
  exportMremote: api.exportMremote,
  expandedFolders,
  refreshTree,
  writeStatus,
  formatError,
});

const shellController = createShellController({
  requireButton: (selector) => must<HTMLButtonElement>(selector),
  requireDiv: (selector) => must<HTMLDivElement>(selector),
  requireInput: (selector) => must<HTMLInputElement>(selector),
  requireElement: (selector) => must<HTMLElement>(selector),
  vaultLock: api.vaultLock,
  vaultUnlock: api.vaultUnlock,
  formatError,
  writeStatus,
  scheduleActiveTabResize,
  showImportModal,
  showExportModal,
  showPreferencesModal,
  showAboutModal,
  hideContextMenu,
  hideModal,
  getAppShellEl: () => appShellEl,
  getUnlockOverlayEl: () => unlockOverlayEl,
  getUnlockInputEl: () => unlockInputEl,
  getUnlockStatusEl: () => unlockStatusEl,
  getContextMenuEl: () => contextMenuEl,
  getModalOverlayEl: () => modalOverlayEl,
  getWorkspaceEl: () => workspaceEl,
  getFileMenuTriggerEl: () => fileMenuTriggerEl,
  getFileMenuEl: () => fileMenuEl,
  getSettingsMenuTriggerEl: () => settingsMenuTriggerEl,
  getSettingsMenuEl: () => settingsMenuEl,
  getVaultLockEl: () => vaultLockEl,
  getAppVersionEl: () => appVersionEl,
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
          <div class="sidebar-header">
            <span class="sidebar-header-title">Connections</span>
            <div class="sidebar-header-actions">
              <button class="btn btn-sm icon-btn" id="tree-expand-all" type="button" aria-label="Expand all folders" title="Expand all folders">
                ${faIcon('fa-solid fa-square-plus')}
              </button>
              <button class="btn btn-sm icon-btn" id="tree-collapse-all" type="button" aria-label="Collapse all folders" title="Collapse all folders">
                ${faIcon('fa-solid fa-square-minus')}
              </button>
            </div>
          </div>
          <div class="sidebar-search">
            <input id="tree-search" class="sidebar-search-input" type="search" placeholder="Search connections" aria-label="Search connections" />
          </div>
          <div id="tree" class="tree-container"></div>
        </aside>
        <div class="sidebar-resizer" id="sidebar-resizer"></div>
        <main class="main-area">
          <div id="tabs" class="tab-bar"></div>
          <div id="workspace" class="workspace"></div>
        </main>
      </div>
      <div class="status-bar">
        <span id="connection-check-status" class="connection-check-status" aria-live="polite"></span>
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
  connectionCheckStatusEl = must<HTMLSpanElement>('#connection-check-status');
  treeEl = must<HTMLDivElement>('#tree');
  treeSearchEl = must<HTMLInputElement>('#tree-search');
  treeExpandAllEl = must<HTMLButtonElement>('#tree-expand-all');
  treeCollapseAllEl = must<HTMLButtonElement>('#tree-collapse-all');
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
  connectionCheckRequestSeq = 0;
  treeSearchQuery = '';
  expandedFolders.clear();
  expandedFolders.add(null);
  clearConnectionCheckStatus();

  wireToolbar();
  wireTreeControls();
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
  shellController.wireToolbar();
}

/* ── Unlock Modal ─────────────────────────────────── */

function wireUnlockModal(): void {
  shellController.wireUnlockModal();
}

function showUnlockModal(message = ''): void {
  shellController.showUnlockModal(message);
}

function hideUnlockModal(): void {
  shellController.hideUnlockModal();
}

/* ── Sidebar Resizer ──────────────────────────────── */

function wireSidebarResizer(): void {
  shellController.wireSidebarResizer();
}

function wireWorkspaceResizeObserver(): void {
  shellController.wireWorkspaceResizeObserver();
}

/* ── Global Keyboard ──────────────────────────────── */

function wireGlobalKeyboard(): void {
  shellController.wireGlobalKeyboard();
}

function wireGlobalContextMenuSuppression(): void {
  shellController.wireGlobalContextMenuSuppression();
}

/* ── Tree ─────────────────────────────────────────── */

async function refreshTree(): Promise<void> {
  await treeController.refreshTree();
}

function renderTree(): void {
  treeController.renderTree();
}

function wireTreeControls(): void {
  const searchEl = treeSearchEl;
  const expandAllEl = treeExpandAllEl;
  const collapseAllEl = treeCollapseAllEl;
  if (!searchEl || !expandAllEl || !collapseAllEl) return;

  searchEl.value = treeSearchQuery;

  searchEl.addEventListener('input', () => {
    treeSearchQuery = searchEl.value;
    renderTree();
  });

  searchEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || searchEl.value.length === 0) return;
    event.preventDefault();
    searchEl.value = '';
    treeSearchQuery = '';
    renderTree();
  });

  expandAllEl.addEventListener('click', () => {
    expandAllTreeFolders();
    renderTree();
  });

  collapseAllEl.addEventListener('click', () => {
    collapseAllTreeFolders();
    renderTree();
  });
}

function expandAllTreeFolders(): void {
  expandedFolders.clear();
  expandedFolders.add(null);
  for (const node of nodes) {
    if (node.kind === 'folder') {
      expandedFolders.add(node.id);
    }
  }
}

function collapseAllTreeFolders(): void {
  expandedFolders.clear();
  expandedFolders.add(null);
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

  const hasSavedPassword =
    node.kind === 'ssh' ? Boolean(node.ssh?.authRef) : Boolean(node.rdp?.credentialRef);
  items.push({
    label: 'Show saved password',
    icon: faIcon('fa-solid fa-eye'),
    disabled: !hasSavedPassword,
    action: () => {
      void showSavedPasswordModal(node).catch((error) => writeStatus(formatError(error)));
    }
  });

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
  crudModalController.showFolderModal(parentId);
}

/* ── Connection Modal (New / Edit) ────────────────── */

function showConnectionModal(
  protocol: 'ssh' | 'rdp',
  parentId: string | null,
  existing?: ConnectionNode
): void {
  connectionModalController.showConnectionModal(protocol, parentId, existing);
}

function showEditConnectionModal(node: ConnectionNode): void {
  connectionModalController.showEditConnectionModal(node);
}

async function showSavedPasswordModal(node: ConnectionNode): Promise<void> {
  if (node.kind !== 'ssh' && node.kind !== 'rdp') {
    throw new Error('Saved password is available only for SSH and RDP connections');
  }

  let passwordValue = await api.getConnectionSavedPassword(node.id);
  const fieldId = `saved-password-${crypto.randomUUID()}`;
  let passwordInputEl: HTMLInputElement | null = null;
  let toggleBtnEl: HTMLButtonElement | null = null;
  let revealed = false;

  const syncPasswordVisibility = (): void => {
    if (!passwordInputEl || !toggleBtnEl) return;
    passwordInputEl.type = revealed ? 'text' : 'password';
    toggleBtnEl.textContent = revealed ? 'Hide' : 'Show';
    toggleBtnEl.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  };

  showModal('Saved password', (card) => {
    const intro = document.createElement('p');
    intro.textContent = `Saved login password for ${node.name}.`;

    const field = document.createElement('div');
    field.className = 'form-field';

    const label = document.createElement('label');
    label.htmlFor = fieldId;
    label.textContent = 'Password';

    const input = document.createElement('input');
    input.id = fieldId;
    input.type = 'password';
    input.readOnly = true;
    input.value = passwordValue;
    input.autocomplete = 'off';
    input.spellcheck = false;
    passwordInputEl = input;

    field.append(label, input);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-ghost';
    toggleBtnEl = toggleBtn;
    toggleBtn.addEventListener('click', () => {
      revealed = !revealed;
      syncPasswordVisibility();
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-ghost';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      void writeClipboardText(passwordValue)
        .then(() => {
          writeStatus('Saved password copied');
        })
        .catch((error) => {
          writeStatus(formatError(error));
        });
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', hideModal);

    actions.append(toggleBtn, copyBtn, closeBtn);
    card.append(intro, field, actions);
    syncPasswordVisibility();

    modalOnHide = () => {
      if (passwordInputEl) {
        passwordInputEl.value = '';
        passwordInputEl.type = 'password';
      }
      revealed = false;
      passwordValue = '';
      passwordInputEl = null;
      toggleBtnEl = null;
    };
  });

  window.setTimeout(() => toggleBtnEl?.focus(), 0);
}

/* ── Rename Modal ─────────────────────────────────── */

function showRenameModal(node: ConnectionNode): void {
  crudModalController.showRenameModal(node);
}

/* ── Delete Modal ─────────────────────────────────── */

function showDeleteModal(node: ConnectionNode): void {
  crudModalController.showDeleteModal(node);
}

/* ── Import Modal ─────────────────────────────────── */

function showImportModal(): void {
  crudModalController.showImportModal();
}

/* ── Export Modal ──────────────────────────────────── */

function showExportModal(): void {
  crudModalController.showExportModal();
}

/* ── SSH / RDP Session ────────────────────────────── */

async function openSshWithStatus(node: ConnectionNode): Promise<void> {
  await protocolsController.openSshWithStatus(node);
}

async function openSsh(node: ConnectionNode): Promise<boolean> {
  return protocolsController.openSsh(node);
}

async function openRdp(node: ConnectionNode): Promise<void> {
  await protocolsController.openRdp(node);
}

/* ── RDP Helpers ──────────────────────────────────── */

function getRdpViewport(element: HTMLElement): RdpViewport | null {
  return protocolsController.getRdpViewport(element);
}

async function syncRdpTabVisibility(): Promise<void> {
  await protocolsController.syncRdpTabVisibility();
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
  shellController.toggleFileMenu();
}

function setFileMenuOpen(nextOpen: boolean): void {
  shellController.setFileMenuOpen(nextOpen);
}

function toggleSettingsMenu(): void {
  shellController.toggleSettingsMenu();
}

/* ── SFTP Modal ───────────────────────────────────── */

async function openSftpModalForTab(tabKey: string): Promise<void> {
  await sftpController.openSftpModalForTab(tabKey);
}

function setSettingsMenuOpen(nextOpen: boolean): void {
  shellController.setSettingsMenuOpen(nextOpen);
}

function loadAppVersion(): void {
  shellController.loadAppVersion(APP_VERSION ? `v${APP_VERSION}` : 'v?');
}

/* ── Utility ──────────────────────────────────────── */

function writeStatus(message: string): void {
  statusController.writeStatus(message);
}

function clearConnectionCheckStatus(): void {
  statusController.clearConnectionCheckStatus();
}

function writeConnectionCheckStatus(connectionName: string, reachable: boolean): void {
  statusController.writeConnectionCheckStatus(connectionName, reachable);
}

async function checkSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
  await statusController.checkSelectedConnection(nodeId, connectionName);
}

async function withStatus(message: string, fn: () => Promise<unknown>): Promise<void> {
  await statusController.withStatus(message, fn);
}

function resetMainShellState(): void {
  shellController.reset();
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
}
