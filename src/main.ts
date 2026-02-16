import './styles.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { api } from './api';
import type { ConnectionNode, ConnectionUpsert, NodeKind } from './types';

type SessionTab = {
  sessionId: string;
  title: string;
  root: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  cleanup: Array<() => void>;
};

const app = must<HTMLDivElement>('#app');

let statusEl: HTMLElement | null = null;
let treeEl: HTMLDivElement | null = null;
let tabsEl: HTMLDivElement | null = null;
let workspaceEl: HTMLDivElement | null = null;

const tabs = new Map<string, SessionTab>();
let nodes: ConnectionNode[] = [];
let activeTab: string | null = null;

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

    renderMainApp();
  } catch (error) {
    renderStartupError(formatError(error));
  }
}

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
  treeEl = null;
  tabsEl = null;
  workspaceEl = null;
}

function renderStartupError(message: string): void {
  app.innerHTML = `
    <div class="setup-shell">
      <section class="setup-card">
        <h1>Janus</h1>
        <p class="setup-copy">The app could not read vault status.</p>
        <p id="setup-status" class="setup-status">${escapeHtml(message)}</p>
        <div class="setup-actions">
          <button id="setup-retry">Retry</button>
        </div>
      </section>
    </div>
  `;

  statusEl = must<HTMLElement>('#setup-status');
  treeEl = null;
  tabsEl = null;
  workspaceEl = null;

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
  treeEl = null;
  tabsEl = null;
  workspaceEl = null;

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
            <button id="setup-next">Continue</button>
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
        <div class="field">
          <input id="setup-passphrase" type="password" placeholder="Master passphrase" />
        </div>
        <div class="field">
          <input id="setup-passphrase-confirm" type="password" placeholder="Confirm passphrase" />
        </div>
        <div class="setup-actions">
          <button id="setup-back">Back</button>
          <button id="setup-init">Initialize vault</button>
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

        renderMainApp();
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

function renderMainApp(): void {
  app.innerHTML = `
    <div class="toolbar">
      <strong>Janus</strong>
      <input id="passphrase" type="password" placeholder="Master passphrase" />
      <button id="vault-unlock">Unlock</button>
      <button id="vault-lock">Lock</button>
      <input id="import-path" placeholder="Path to mRemoteNG XML" />
      <button id="import-dry">Import Dry Run</button>
      <button id="import-apply">Import Apply</button>
      <input id="export-path" placeholder="Export path" />
      <button id="export-btn">Export</button>
      <span id="status" class="log"></span>
    </div>
    <div class="layout">
      <aside class="sidebar">
        <section class="panel">
          <h3>Create Folder</h3>
          <div class="field"><input id="folder-name" placeholder="Folder name" /></div>
          <div class="field"><input id="folder-parent" placeholder="Parent ID (optional)" /></div>
          <button id="folder-create">Save Folder</button>
        </section>

        <section class="panel">
          <h3>Create SSH</h3>
          <div class="field"><input id="ssh-name" placeholder="Display name" /></div>
          <div class="field"><input id="ssh-parent" placeholder="Parent ID (optional)" /></div>
          <div class="field"><input id="ssh-host" placeholder="Host" /></div>
          <div class="field"><input id="ssh-port" value="22" /></div>
          <div class="field"><input id="ssh-user" placeholder="Username" /></div>
          <div class="field"><input id="ssh-password" type="password" placeholder="Password (optional)" /></div>
          <div class="field"><input id="ssh-key" placeholder="Private key path (optional)" /></div>
          <div class="field"><input id="ssh-key-pass" type="password" placeholder="Key passphrase (optional)" /></div>
          <button id="ssh-create">Save SSH</button>
        </section>

        <section class="panel">
          <h3>Create RDP</h3>
          <div class="field"><input id="rdp-name" placeholder="Display name" /></div>
          <div class="field"><input id="rdp-parent" placeholder="Parent ID (optional)" /></div>
          <div class="field"><input id="rdp-host" placeholder="Host" /></div>
          <div class="field"><input id="rdp-port" value="3389" /></div>
          <div class="field"><input id="rdp-user" placeholder="Username (optional)" /></div>
          <div class="field"><input id="rdp-domain" placeholder="Domain (optional)" /></div>
          <div class="field"><input id="rdp-password" type="password" placeholder="Password (optional)" /></div>
          <button id="rdp-create">Save RDP</button>
        </section>

        <section class="panel tree">
          <h3>Connection Tree</h3>
          <div id="tree"></div>
        </section>
      </aside>
      <main class="main">
        <div id="tabs" class="tabs"></div>
        <div id="workspace" class="workspace"></div>
      </main>
    </div>
  `;

  statusEl = must<HTMLSpanElement>('#status');
  treeEl = must<HTMLDivElement>('#tree');
  tabsEl = must<HTMLDivElement>('#tabs');
  workspaceEl = must<HTMLDivElement>('#workspace');

  tabs.clear();
  nodes = [];
  activeTab = null;

  wireToolbar();
  wireCreateActions();
  void refreshTree();
}

function wireToolbar(): void {
  must<HTMLButtonElement>('#vault-unlock').addEventListener('click', async () => {
    await withStatus('Vault unlocked', async () => {
      await api.vaultUnlock(getValue('#passphrase'));
    });
  });

  must<HTMLButtonElement>('#vault-lock').addEventListener('click', async () => {
    await withStatus('Vault locked', async () => {
      await api.vaultLock();
    });
  });

  must<HTMLButtonElement>('#import-dry').addEventListener('click', async () => {
    const report = await api.importMremote({ path: getValue('#import-path'), mode: 'dry_run' });
    writeStatus(`Dry run: created=${report.created}, updated=${report.updated}, skipped=${report.skipped}`);
  });

  must<HTMLButtonElement>('#import-apply').addEventListener('click', async () => {
    await withStatus('Import applied', async () => {
      await api.importMremote({ path: getValue('#import-path'), mode: 'apply' });
      await refreshTree();
    });
  });

  must<HTMLButtonElement>('#export-btn').addEventListener('click', async () => {
    await withStatus('Export complete', async () => {
      await api.exportMremote(getValue('#export-path'));
    });
  });
}

function wireCreateActions(): void {
  must<HTMLButtonElement>('#folder-create').addEventListener('click', async () => {
    await withStatus('Folder saved', async () => {
      await api.upsertFolder({
        id: crypto.randomUUID(),
        parentId: optional('#folder-parent'),
        name: getValue('#folder-name'),
        orderIndex: Date.now()
      });
      await refreshTree();
    });
  });

  must<HTMLButtonElement>('#ssh-create').addEventListener('click', async () => {
    const payload: ConnectionUpsert = {
      id: crypto.randomUUID(),
      parentId: optional('#ssh-parent'),
      kind: 'ssh',
      name: getValue('#ssh-name'),
      orderIndex: Date.now(),
      ssh: {
        host: getValue('#ssh-host'),
        port: Number(getValue('#ssh-port') || '22'),
        username: getValue('#ssh-user'),
        strictHostKey: true,
        password: optional('#ssh-password'),
        keyPath: optional('#ssh-key'),
        keyPassphrase: optional('#ssh-key-pass')
      }
    };

    await withStatus('SSH saved', async () => {
      await api.upsertConnection(payload);
      await refreshTree();
    });
  });

  must<HTMLButtonElement>('#rdp-create').addEventListener('click', async () => {
    const payload: ConnectionUpsert = {
      id: crypto.randomUUID(),
      parentId: optional('#rdp-parent'),
      kind: 'rdp',
      name: getValue('#rdp-name'),
      orderIndex: Date.now(),
      rdp: {
        host: getValue('#rdp-host'),
        port: Number(getValue('#rdp-port') || '3389'),
        username: optional('#rdp-user'),
        domain: optional('#rdp-domain'),
        screenMode: 2,
        password: optional('#rdp-password')
      }
    };

    await withStatus('RDP saved', async () => {
      await api.upsertConnection(payload);
      await refreshTree();
    });
  });
}

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

  const renderBranch = (parentId: string | null): HTMLUListElement => {
    const ul = document.createElement('ul');
    const children = byParent.get(parentId) ?? [];
    children.sort((a, b) => a.orderIndex - b.orderIndex);

    for (const node of children) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'tree-node';

      const label = document.createElement('span');
      label.textContent = `${iconFor(node.kind)} ${node.name} (${node.id.slice(0, 8)})`;

      row.appendChild(label);

      if (node.kind === 'ssh') {
        const btn = document.createElement('button');
        btn.textContent = 'Open SSH';
        btn.addEventListener('click', () => {
          void openSsh(node);
        });
        row.appendChild(btn);
      }

      if (node.kind === 'rdp') {
        const btn = document.createElement('button');
        btn.textContent = 'Open RDP';
        btn.addEventListener('click', () => {
          void withStatus('Launching RDP', async () => {
            await api.launchRdp(node.id);
          });
        });
        row.appendChild(btn);
      }

      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        void withStatus('Node deleted', async () => {
          await api.deleteNode(node.id);
          await refreshTree();
        });
      });
      row.appendChild(del);

      li.appendChild(row);
      li.appendChild(renderBranch(node.id));
      ul.appendChild(li);
    }

    return ul;
  };

  treeEl.replaceChildren(renderBranch(null));
}

async function openSsh(node: ConnectionNode): Promise<void> {
  if (node.kind !== 'ssh' || !workspaceEl) return;

  const root = document.createElement('div');
  root.className = 'terminal';
  root.style.visibility = 'hidden';
  workspaceEl.appendChild(root);

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    theme: {
      background: '#1f2328'
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

  tabs.set(sessionId, {
    sessionId,
    title: node.name,
    root,
    terminal,
    fitAddon,
    cleanup
  });

  terminal.writeln(`Connected to ${node.ssh?.host ?? node.name}`);
  activateTab(sessionId);
  renderTabs();
}

function renderTabs(): void {
  if (!tabsEl) return;

  tabsEl.replaceChildren();

  for (const tab of tabs.values()) {
    const el = document.createElement('div');
    el.className = `tab ${activeTab === tab.sessionId ? 'active' : ''}`;
    el.textContent = tab.title;

    el.addEventListener('click', () => {
      activateTab(tab.sessionId);
    });

    const close = document.createElement('button');
    close.textContent = 'x';
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

  if (activeTab === sessionId) {
    activeTab = tabs.keys().next().value ?? null;
    if (activeTab) {
      activateTab(activeTab);
    }
  }

  renderTabs();
}

function iconFor(kind: NodeKind): string {
  if (kind === 'folder') return 'DIR';
  if (kind === 'ssh') return 'SSH';
  return 'RDP';
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

function writeStatus(message: string): void {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

async function withStatus(message: string, fn: () => Promise<void>): Promise<void> {
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

function getValue(selector: string): string {
  return must<HTMLInputElement>(selector).value.trim();
}

function optional(selector: string): string | null {
  const value = getValue(selector);
  return value.length > 0 ? value : null;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
