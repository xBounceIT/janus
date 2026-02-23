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
  writeConnectionCheckStatus: (connectionName: string, reachable: boolean) => void;
  checkSelectedConnection: (nodeId: string, connectionName: string) => Promise<void>;
  withStatus: (message: string, fn: () => Promise<unknown>) => Promise<void>;
};

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
    connectionCheckStatusEl.classList.remove('is-reachable', 'is-unreachable');
    connectionCheckStatusEl.replaceChildren();
  }

  function writeConnectionCheckStatus(connectionName: string, reachable: boolean): void {
    const connectionCheckStatusEl = deps.getConnectionCheckStatusEl();
    if (!connectionCheckStatusEl) return;

    connectionCheckStatusEl.classList.remove('is-reachable', 'is-unreachable');
    connectionCheckStatusEl.classList.add(reachable ? 'is-reachable' : 'is-unreachable');

    const iconEl = document.createElement('i');
    iconEl.className = reachable ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
    iconEl.setAttribute('aria-hidden', 'true');

    const host = document.createElement('span');
    host.className = 'connection-check-status-host';
    host.textContent = connectionName;

    const outcome = document.createElement('span');
    outcome.className = 'connection-check-status-outcome';
    outcome.textContent = reachable ? 'REACHABLE' : 'UNREACHABLE';

    connectionCheckStatusEl.replaceChildren(iconEl, host, outcome);
  }

  async function checkSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
    const requestId = deps.nextConnectionCheckRequestSeq();

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
    writeConnectionCheckStatus,
    checkSelectedConnection,
    withStatus,
  };
}
