import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type {
  ConnectionNode,
  RdpLifecycleEvent,
  RdpViewport,
  SshHostKeyMismatchResult,
} from '../types';
import type { RdpSessionTab, SessionTab, SshSessionTab } from './types';

type ApiClient = typeof import('../api').api;

export type ProtocolsControllerDeps = {
  api: ApiClient;
  tabs: Map<string, SessionTab>;
  getWorkspaceEl: () => HTMLDivElement | null;
  getModalOverlayEl: () => HTMLDivElement | null;
  showModal: (title: string, buildContent: (card: HTMLDivElement) => void) => void;
  hideModal: () => void;
  writeStatus: (message: string) => void;
  formatError: (error: unknown) => string;
  escapeHtml: (input: string) => string;
  getActiveTab: () => string | null;
  setActiveTab: (tabKey: string | null) => void;
  nextTabTitle: (baseTitle: string) => string;
  renderTabs: () => void;
  activateTab: (tabKey: string) => void;
  finalizeTabRemoval: (removedTabKey: string) => void;
  scheduleActiveTabResize: () => void;
  closeTab: (tabKey: string) => Promise<void>;
  sshOpenWatchdogTimeoutMs: number;
  sshOpenWatchdogError: string;
};

export type ProtocolsController = {
  openSshWithStatus: (node: ConnectionNode) => Promise<void>;
  openSsh: (node: ConnectionNode) => Promise<boolean>;
  openRdp: (node: ConnectionNode) => Promise<void>;
  getRdpViewport: (element: HTMLElement) => RdpViewport | null;
  syncRdpTabVisibility: () => Promise<void>;
};

export function createProtocolsController(deps: ProtocolsControllerDeps): ProtocolsController {
  async function openSshWithStatus(node: ConnectionNode): Promise<void> {
    deps.writeStatus(`Opening SSH: ${node.name}...`);
    try {
      const opened = await openSsh(node);
      if (opened) {
        deps.writeStatus(`SSH ready: ${node.name}`);
      }
    } catch (error) {
      deps.writeStatus(deps.formatError(error));
    }
  }

  async function openSsh(node: ConnectionNode): Promise<boolean> {
    if (node.kind !== 'ssh') {
      throw new Error('cannot open non-SSH node');
    }
    if (!deps.getWorkspaceEl()) {
      throw new Error('SSH workspace unavailable');
    }

    const sessionId = await openSshSession(node);
    if (!sessionId) {
      return false;
    }

    if (!deps.tabs.has(sessionId)) {
      throw new Error('SSH tab initialization failed');
    }
    deps.activateTab(sessionId);

    return true;
  }

  async function openSshSession(node: ConnectionNode): Promise<string | null> {
    const workspaceEl = deps.getWorkspaceEl();
    if (node.kind !== 'ssh' || !workspaceEl) {
      throw new Error('cannot open non-SSH node');
    }

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
        white: '#bac2de',
      },
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
      title: deps.nextTabTitle(node.name),
      root,
      overlay,
      terminal,
      fitAddon,
      sshState: 'connecting',
      exitCode: null,
      cleanup,
    };
    deps.tabs.set(sessionId, tab);
    deps.activateTab(sessionId);

    try {
      const unlistenStdout = await deps.api.listenStdout(sessionId, (data) => terminal.write(data));
      cleanup.push(unlistenStdout);

      const unlistenExit = await deps.api.listenExit(sessionId, (code) => {
        terminal.writeln(`\r\n[session exited with code ${code}]`);
        const current = deps.tabs.get(sessionId);
        if (!current || current.kind !== 'ssh' || current.sshState === 'exited') {
          return;
        }
        if (current.sshState === 'connecting' && code !== 0) {
          setOverlayState(current.overlay, 'error', `Connection failed (exit code ${code})`);
        }
        current.sshState = 'exited';
        current.exitCode = code;
        deps.renderTabs();
      });
      cleanup.push(unlistenExit);

      const onDataDisposable = terminal.onData((data) => {
        const current = deps.tabs.get(sessionId);
        if (!current || current.kind !== 'ssh' || current.sshState !== 'connected') {
          return;
        }
        void deps.api.writeSsh(sessionId, data).catch(() => undefined);
      });
      cleanup.push(() => onDataDisposable.dispose());
    } catch (error) {
      for (const fn of cleanup) fn();
      deps.tabs.delete(sessionId);
      terminal.dispose();
      root.remove();
      deps.finalizeTabRemoval(sessionId);
      throw error;
    }

    try {
      const openPromise = deps.api.openSsh(node.id, { cols, rows, sessionId });
      let watchdogTimer: number | null = null;
      const watchdogPromise = new Promise<never>((_resolve, reject) => {
        watchdogTimer = window.setTimeout(() => {
          reject(new Error(deps.sshOpenWatchdogError));
        }, deps.sshOpenWatchdogTimeoutMs);
      });

      let openResult: Awaited<ReturnType<ApiClient['openSsh']>>;
      try {
        openResult = (await Promise.race([openPromise, watchdogPromise])) as Awaited<
          ReturnType<ApiClient['openSsh']>
        >;
      } catch (error) {
        if (watchdogTimer !== null) {
          window.clearTimeout(watchdogTimer);
        }
        if (error instanceof Error && error.message === deps.sshOpenWatchdogError) {
          void openPromise
            .then((lateResult) => {
              if (lateResult.type === 'opened') {
                void deps.api.closeSsh(lateResult.sessionId).catch(() => undefined);
              }
            })
            .catch(() => undefined);
        }
        throw error;
      }

      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
      }

      const current = deps.tabs.get(sessionId);
      if (!current || current.kind !== 'ssh') {
        if (openResult.type === 'opened') {
          await deps.api.closeSsh(openResult.sessionId).catch(() => undefined);
        }
        terminal.dispose();
        root.remove();
        return null;
      }

      if (openResult.type === 'hostKeyMismatch') {
        deps.writeStatus(`SSH host key verification required for ${openResult.host}:${openResult.port}`);
        for (const fn of cleanup) fn();
        deps.tabs.delete(sessionId);
        terminal.dispose();
        root.remove();
        deps.finalizeTabRemoval(sessionId);
        showSshHostKeyMismatchModal(node, openResult);
        return null;
      }

      if (current.sshState !== 'exited') {
        current.sshState = 'connected';
        setOverlayState(current.overlay, 'connected', '');
      }
      deps.renderTabs();
    } catch (error) {
      const failedTab = deps.tabs.get(sessionId);
      if (failedTab && failedTab.kind === 'ssh') {
        setOverlayState(failedTab.overlay, 'error', deps.formatError(error));
      }
      for (const fn of cleanup) fn();
      deps.tabs.delete(sessionId);
      terminal.dispose();
      root.remove();
      deps.finalizeTabRemoval(sessionId);
      throw error;
    }

    return sessionId;
  }

  function showSshHostKeyMismatchModal(node: ConnectionNode, mismatch: SshHostKeyMismatchResult): void {
    if (!deps.getModalOverlayEl()) {
      deps.writeStatus(
        `${mismatch.warning} Target ${mismatch.host}:${mismatch.port} (${mismatch.presentedFingerprint})`,
      );
      return;
    }

    deps.showModal('SSH Host Key Warning', (card) => {
      card.innerHTML += `
        <div class="host-key-warning" role="alert">
          <p class="host-key-warning-summary">${deps.escapeHtml(mismatch.warning)}</p>
          <p class="host-key-warning-target"><strong>Target:</strong> ${deps.escapeHtml(mismatch.host)}:${deps.escapeHtml(String(mismatch.port))}</p>
          <div class="host-key-warning-grid">
            <div>
              <p><strong>Saved key</strong></p>
              <p>Type: ${deps.escapeHtml(mismatch.storedKeyType)}</p>
              <p>Fingerprint: ${deps.escapeHtml(mismatch.storedFingerprint)}</p>
            </div>
            <div>
              <p><strong>Presented key</strong></p>
              <p>Type: ${deps.escapeHtml(mismatch.presentedKeyType)}</p>
              <p>Fingerprint: ${deps.escapeHtml(mismatch.presentedFingerprint)}</p>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn btn-danger" id="modal-confirm">Update Saved Key &amp; Connect</button>
        </div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);
      card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
        const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Updating...';

        try {
          await deps.api.updateSshHostKeyFromMismatch(node.id, mismatch.token);
          deps.hideModal();
          deps.writeStatus('Saved updated host key; reconnecting...');
          await openSshWithStatus(node);
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          btn.disabled = false;
          btn.textContent = 'Update Saved Key & Connect';
        }
      });
    });
  }

  async function openRdp(node: ConnectionNode): Promise<void> {
    if (node.kind !== 'rdp' || !deps.getWorkspaceEl()) return;

    await openRdpSession(node);
  }

  async function openRdpSession(node: ConnectionNode): Promise<void> {
    const workspaceEl = deps.getWorkspaceEl();
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
      title: deps.nextTabTitle(node.name),
      root,
      host,
      overlay,
      rdpState: 'connecting',
      cleanup: [],
    };

    deps.tabs.set(tabKey, tab);
    deps.activateTab(tabKey);

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

      sessionId = await deps.api.openRdp(node.id, initialViewport);
      if (!deps.tabs.has(tabKey)) {
        await deps.api.closeRdp(sessionId).catch(() => undefined);
        return;
      }

      const sid = sessionId;
      const unlistenState = await deps.api.listenRdpState(sid, (event) => {
        const current = deps.tabs.get(tabKey);
        if (!current || current.kind !== 'rdp') return;
        applyRdpLifecycleEvent(current, event);
      });
      cleanup.push(unlistenState);

      const unlistenExit = await deps.api.listenRdpExit(sid, (_reason) => {
        void deps.closeTab(tabKey);
      });
      cleanup.push(unlistenExit);

      const current = deps.tabs.get(tabKey);
      if (!current || current.kind !== 'rdp') {
        runCleanup();
        await deps.api.closeRdp(sessionId).catch(() => undefined);
        return;
      }

      current.sessionId = sessionId;

      if (tabKey !== sessionId) {
        deps.tabs.delete(tabKey);
        deps.tabs.set(sessionId, current);
        if (deps.getActiveTab() === tabKey) {
          deps.setActiveTab(sessionId);
        }
        tabKey = sessionId;
        deps.renderTabs();
      }

      void syncRdpTabVisibility();
      deps.scheduleActiveTabResize();
    } catch (error) {
      runCleanup();
      if (sessionId) {
        await deps.api.closeRdp(sessionId).catch(() => undefined);
      }
      const failedTab = deps.tabs.get(tabKey);
      if (failedTab) {
        failedTab.root.remove();
        deps.tabs.delete(tabKey);
      }
      deps.finalizeTabRemoval(tabKey);
      throw error;
    }
  }

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
      height,
    };
  }

  function setOverlayState(
    overlay: HTMLDivElement,
    state: 'connecting' | 'connected' | 'error',
    text: string,
  ): void {
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
    const hresultText =
      event.hresult === null
        ? 'unknown HRESULT'
        : `HRESULT 0x${(event.hresult >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    setOverlayState(
      tab.overlay,
      'error',
      `RDP host init failed at ${event.stage} (${hresultText}): ${event.message}`,
    );
  }

  async function syncRdpTabVisibility(): Promise<void> {
    const operations: Promise<unknown>[] = [];

    for (const [tabKey, tab] of deps.tabs.entries()) {
      if (tab.kind !== 'rdp' || !tab.sessionId) continue;

      if (tabKey === deps.getActiveTab() && tab.root.style.display !== 'none') {
        const viewport = getRdpViewport(tab.host);
        if (!viewport) continue;
        operations.push(deps.api.showRdp(tab.sessionId));
        operations.push(deps.api.setRdpBounds(tab.sessionId, viewport));
      } else {
        operations.push(deps.api.hideRdp(tab.sessionId));
      }
    }

    await Promise.allSettled(operations);
  }

  return {
    openSshWithStatus,
    openSsh,
    openRdp,
    getRdpViewport,
    syncRdpTabVisibility,
  };
}
