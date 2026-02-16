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

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing app root');
}

app.innerHTML = `
  <div class="toolbar">
    <strong>Janus</strong>
    <input id="passphrase" type="password" placeholder="Master passphrase" />
    <button id="vault-init">Initialize Vault</button>
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

const statusEl = must<HTMLSpanElement>('#status');
const treeEl = must<HTMLDivElement>('#tree');
const tabsEl = must<HTMLDivElement>('#tabs');
const workspaceEl = must<HTMLDivElement>('#workspace');

const tabs = new Map<string, SessionTab>();
let nodes: ConnectionNode[] = [];
let activeTab: string | null = null;

api.listenErrors((message) => writeStatus(message));

window.addEventListener('resize', () => {
  if (activeTab && tabs.has(activeTab)) {
    tabs.get(activeTab)?.fitAddon.fit();
  }
});

void refreshTree();
wireToolbar();
wireCreateActions();

function wireToolbar(): void {
  must<HTMLButtonElement>('#vault-init').addEventListener('click', async () => {
    await withStatus('Vault initialized', async () => {
      await api.vaultInitialize(getValue('#passphrase'));
    });
  });

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
  if (node.kind !== 'ssh') return;

  const sessionId = await api.openSsh(node.id);
  const root = document.createElement('div');
  root.className = 'terminal';
  root.style.display = 'none';
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

  const cleanup: Array<() => void> = [];
  const unlistenStdout = await api.listenStdout(sessionId, (data) => terminal.write(data));
  cleanup.push(unlistenStdout);

  const unlistenExit = await api.listenExit(sessionId, (code) => {
    terminal.writeln(`\r\n[session exited with ${code}]`);
  });
  cleanup.push(unlistenExit);

  terminal.onData((data) => {
    void api.writeSsh(sessionId, data);
  });

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

  tabs.get(sessionId)?.fitAddon.fit();
  void api.resizeSsh(sessionId, 120, 32);
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

function writeStatus(message: string): void {
  statusEl.textContent = message;
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
