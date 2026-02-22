import type { RdpViewport } from '../types';
import type { SessionTab } from './types';

export type TabsControllerDeps = {
  tabs: Map<string, SessionTab>;
  getTabsEl: () => HTMLDivElement | null;
  getActiveTab: () => string | null;
  setActiveTab: (tabKey: string | null) => void;
  getActiveSftpModalTabKey: () => string | null;
  hideModal: () => void;
  closeSsh: (sessionId: string) => Promise<unknown>;
  closeRdp: (sessionId: string) => Promise<unknown>;
  resizeSsh: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
  setRdpBounds: (sessionId: string, viewport: RdpViewport) => Promise<unknown>;
  getRdpViewport: (element: HTMLElement) => RdpViewport | null;
  syncRdpTabVisibility: () => Promise<void>;
  showContextMenu: (x: number, y: number, actions: Array<unknown>) => void;
  buildTabMenuActions: (tabKey: string, tab: SessionTab) => Array<unknown>;
  openSftpModalForTab: (tabKey: string) => Promise<void>;
  faIcon: (name: string) => string;
  sftpIcon: () => string;
  getPendingTabResizeFrame: () => number | null;
  setPendingTabResizeFrame: (frame: number | null) => void;
};

export type TabsController = {
  nextTabTitle: (baseTitle: string) => string;
  renderTabs: () => void;
  activateTab: (tabKey: string) => void;
  closeTab: (tabKey: string) => Promise<void>;
  finalizeTabRemoval: (removedTabKey: string) => void;
  resizeActiveTab: () => void;
  fitAndResizeTab: (tab: SessionTab) => void;
  scheduleActiveTabResize: () => void;
};

export function createTabsController(deps: TabsControllerDeps): TabsController {
  function nextTabTitle(baseTitle: string): string {
    let count = 0;
    for (const tab of deps.tabs.values()) {
      if (tab.baseTitle === baseTitle) {
        count += 1;
      }
    }

    return count === 0 ? baseTitle : `${baseTitle} (${count + 1})`;
  }

  function renderTabs(): void {
    const tabsEl = deps.getTabsEl();
    if (!tabsEl) return;

    tabsEl.replaceChildren();

    for (const [tabKey, tab] of deps.tabs.entries()) {
      const el = document.createElement('div');
      el.className = `tab${deps.getActiveTab() === tabKey ? ' active' : ''}`;

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
        deps.showContextMenu(event.clientX, event.clientY, deps.buildTabMenuActions(tabKey, tab));
      });

      if (tab.kind === 'ssh') {
        const sftpBtn = document.createElement('button');
        sftpBtn.className = 'tab-action-btn';
        sftpBtn.type = 'button';
        sftpBtn.title = 'Open SFTP';
        sftpBtn.setAttribute('aria-label', 'Open SFTP');
        sftpBtn.innerHTML = deps.sftpIcon();
        sftpBtn.disabled = tab.sshState !== 'connected' || !tab.sessionId;
        sftpBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          void deps.openSftpModalForTab(tabKey);
        });
        el.appendChild(sftpBtn);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.innerHTML = deps.faIcon('fa-solid fa-xmark');
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
    deps.setActiveTab(tabKey);

    for (const [key, tab] of deps.tabs.entries()) {
      tab.root.style.display = key === tabKey ? 'block' : 'none';
    }

    void deps.syncRdpTabVisibility();
    scheduleActiveTabResize();
    renderTabs();
  }

  async function closeTab(tabKey: string): Promise<void> {
    const tab = deps.tabs.get(tabKey);
    if (!tab) return;

    if (deps.getActiveSftpModalTabKey() === tabKey) {
      deps.hideModal();
    }

    if (tab.kind === 'ssh') {
      if (tab.sessionId) {
        await deps.closeSsh(tab.sessionId).catch(() => undefined);
      }
      tab.terminal.dispose();
    } else if (tab.sessionId) {
      await deps.closeRdp(tab.sessionId).catch(() => undefined);
    }
    for (const fn of tab.cleanup) fn();
    tab.root.remove();
    deps.tabs.delete(tabKey);
    finalizeTabRemoval(tabKey);
  }

  function finalizeTabRemoval(removedTabKey: string): void {
    if (deps.getActiveTab() === removedTabKey) {
      const nextActive = deps.tabs.keys().next().value ?? null;
      deps.setActiveTab(nextActive);
      if (nextActive) {
        activateTab(nextActive);
        return;
      }
    }
    renderTabs();
  }

  function resizeActiveTab(): void {
    const activeTab = deps.getActiveTab();
    if (!activeTab) return;

    const tab = deps.tabs.get(activeTab);
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
      void deps.resizeSsh(tab.sessionId, cols, rows);
      return;
    }

    if (!tab.sessionId) return;
    const viewport = deps.getRdpViewport(tab.host);
    if (!viewport) return;
    void deps.setRdpBounds(tab.sessionId, viewport);
  }

  function scheduleActiveTabResize(): void {
    if (deps.getPendingTabResizeFrame() !== null) return;

    const frame = window.requestAnimationFrame(() => {
      deps.setPendingTabResizeFrame(null);
      resizeActiveTab();
    });
    deps.setPendingTabResizeFrame(frame);
  }

  return {
    nextTabTitle,
    renderTabs,
    activateTab,
    closeTab,
    finalizeTabRemoval,
    resizeActiveTab,
    fitAndResizeTab,
    scheduleActiveTabResize,
  };
}
