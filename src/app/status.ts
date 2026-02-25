export type StatusControllerDeps = {
  getStatusEl: () => HTMLElement | null;
  getConnectionCheckStatusEl: () => HTMLElement | null;
  probeConnectionTcp: (nodeId: string) => Promise<{ reachable: boolean }>;
  formatError: (error: unknown) => string;
  getSelectedNodeId: () => string | null;
  nextConnectionCheckRequestSeq: () => number;
  getConnectionCheckRequestSeq: () => number;
};

export type StatusController = {
  writeStatus: (message: string) => void;
  clearConnectionCheckStatus: () => void;
  writeConnectionCheckPending: (connectionName: string) => void;
  writeConnectionCheckStatus: (connectionName: string, reachable: boolean) => void;
  checkSelectedConnection: (nodeId: string, connectionName: string) => Promise<void>;
  withStatus: (message: string, fn: () => Promise<unknown>) => Promise<void>;
};

type ConnectionCheckVisualState = 'checking' | 'reachable' | 'unreachable';

export function createStatusController(deps: StatusControllerDeps): StatusController {
  function writeStatus(message: string): void {
    const statusEl = deps.getStatusEl();
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function clearConnectionCheckStatus(): void {
    const connectionCheckStatusEl = deps.getConnectionCheckStatusEl();
    if (!connectionCheckStatusEl) return;
    connectionCheckStatusEl.classList.remove('is-checking', 'is-reachable', 'is-unreachable');
    connectionCheckStatusEl.replaceChildren();
  }

  function renderConnectionCheckStatus(connectionName: string, state: ConnectionCheckVisualState): void {
    const connectionCheckStatusEl = deps.getConnectionCheckStatusEl();
    if (!connectionCheckStatusEl) return;

    connectionCheckStatusEl.classList.remove('is-checking', 'is-reachable', 'is-unreachable');
    connectionCheckStatusEl.classList.add(`is-${state}`);

    const iconEl = document.createElement('i');
    iconEl.className =
      state === 'checking'
        ? 'fa-solid fa-circle'
        : state === 'reachable'
          ? 'fa-solid fa-circle-check'
          : 'fa-solid fa-circle-xmark';
    iconEl.setAttribute('aria-hidden', 'true');

    const host = document.createElement('span');
    host.className = 'connection-check-status-host';
    host.textContent = connectionName;

    if (state === 'checking') {
      const detail = document.createElement('span');
      detail.className = 'connection-check-status-detail';
      detail.textContent = 'Checking...';
      connectionCheckStatusEl.replaceChildren(iconEl, host, detail);
      return;
    }

    connectionCheckStatusEl.replaceChildren(iconEl, host);
  }

  function writeConnectionCheckPending(connectionName: string): void {
    renderConnectionCheckStatus(connectionName, 'checking');
  }

  function writeConnectionCheckStatus(connectionName: string, reachable: boolean): void {
    renderConnectionCheckStatus(connectionName, reachable ? 'reachable' : 'unreachable');
  }

  async function checkSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
    const requestId = deps.nextConnectionCheckRequestSeq();
    writeConnectionCheckPending(connectionName);

    try {
      const result = await deps.probeConnectionTcp(nodeId);
      if (requestId !== deps.getConnectionCheckRequestSeq()) return;
      if (deps.getSelectedNodeId() !== nodeId) return;
      writeConnectionCheckStatus(connectionName, result.reachable);
    } catch (error) {
      if (requestId !== deps.getConnectionCheckRequestSeq()) return;
      if (deps.getSelectedNodeId() !== nodeId) return;
      writeStatus(deps.formatError(error));
    }
  }

  async function withStatus(message: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      writeStatus(message);
    } catch (error) {
      writeStatus(deps.formatError(error));
    }
  }

  return {
    writeStatus,
    clearConnectionCheckStatus,
    writeConnectionCheckPending,
    writeConnectionCheckStatus,
    checkSelectedConnection,
    withStatus,
  };
}
