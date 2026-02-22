export type StatusControllerDeps = {
  getStatusEl: () => HTMLElement | null;
  getPingStatusEl: () => HTMLElement | null;
  pingConnectionIcmp: (nodeId: string) => Promise<{ reachable: boolean }>;
  formatError: (error: unknown) => string;
  getSelectedNodeId: () => string | null;
  nextPingRequestSeq: () => number;
  getPingRequestSeq: () => number;
};

export type StatusController = {
  writeStatus: (message: string) => void;
  clearPingStatus: () => void;
  writePingStatus: (connectionName: string, reachable: boolean) => void;
  pingSelectedConnection: (nodeId: string, connectionName: string) => Promise<void>;
  withStatus: (message: string, fn: () => Promise<unknown>) => Promise<void>;
};

export function createStatusController(deps: StatusControllerDeps): StatusController {
  function writeStatus(message: string): void {
    const statusEl = deps.getStatusEl();
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function clearPingStatus(): void {
    const pingStatusEl = deps.getPingStatusEl();
    if (!pingStatusEl) return;
    pingStatusEl.classList.remove('is-reachable', 'is-unreachable');
    pingStatusEl.replaceChildren();
  }

  function writePingStatus(connectionName: string, reachable: boolean): void {
    const pingStatusEl = deps.getPingStatusEl();
    if (!pingStatusEl) return;

    pingStatusEl.classList.remove('is-reachable', 'is-unreachable');
    pingStatusEl.classList.add(reachable ? 'is-reachable' : 'is-unreachable');

    const iconEl = document.createElement('i');
    iconEl.className = reachable ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
    iconEl.setAttribute('aria-hidden', 'true');

    const host = document.createElement('span');
    host.className = 'ping-status-host';
    host.textContent = connectionName;

    const outcome = document.createElement('span');
    outcome.className = 'ping-status-outcome';
    outcome.textContent = reachable ? 'REACHABLE' : 'UNREACHABLE';

    pingStatusEl.replaceChildren(iconEl, host, outcome);
  }

  async function pingSelectedConnection(nodeId: string, connectionName: string): Promise<void> {
    const requestId = deps.nextPingRequestSeq();

    try {
      const result = await deps.pingConnectionIcmp(nodeId);
      if (requestId !== deps.getPingRequestSeq()) return;
      if (deps.getSelectedNodeId() !== nodeId) return;
      writePingStatus(connectionName, result.reachable);
    } catch (error) {
      if (requestId !== deps.getPingRequestSeq()) return;
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
    clearPingStatus,
    writePingStatus,
    pingSelectedConnection,
    withStatus,
  };
}
