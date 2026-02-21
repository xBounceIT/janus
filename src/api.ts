import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ConnectionNode,
  ConnectionUpsert,
  FolderUpsert,
  ImportReport,
  ImportRequest,
  RdpLifecycleEvent,
  RdpViewport,
  SshSessionOpenResult,
  SessionOptions,
  VaultStatus
} from './types';

export const api = {
  vaultStatus: (): Promise<VaultStatus> => invoke('vault_status'),
  vaultInitialize: (passphrase: string) => invoke('vault_initialize', { passphrase }),
  vaultUnlock: (passphrase: string) => invoke('vault_unlock', { passphrase }),
  vaultLock: () => invoke('vault_lock'),
  listTree: (): Promise<ConnectionNode[]> => invoke('connection_tree_list'),
  upsertFolder: (folder: FolderUpsert) => invoke('folder_upsert', { folder }),
  upsertConnection: (connection: ConnectionUpsert) => invoke('connection_upsert', { connection }),
  deleteNode: (nodeId: string) => invoke('node_delete', { nodeId }),
  openSsh: (connectionId: string, sessionOpts: SessionOptions | null = null) =>
    invoke<SshSessionOpenResult>('ssh_session_open', { connectionId, sessionOpts }),
  updateSshHostKeyFromMismatch: (connectionId: string, token: string) =>
    invoke<void>('ssh_host_key_update_from_mismatch', { connectionId, token }),
  writeSsh: (sessionId: string, data: string) => invoke('ssh_session_write', { sessionId, data }),
  resizeSsh: (sessionId: string, cols: number, rows: number) =>
    invoke('ssh_session_resize', { sessionId, cols, rows }),
  closeSsh: (sessionId: string) => invoke('ssh_session_close', { sessionId }),
  launchRdp: (connectionId: string) => invoke('rdp_launch', { connectionId, launchOpts: null }),
  openRdp: (connectionId: string, viewport: RdpViewport) =>
    invoke<string>('rdp_session_open', { connectionId, viewport }),
  closeRdp: (sessionId: string) => invoke<void>('rdp_session_close', { sessionId }),
  setRdpBounds: (sessionId: string, viewport: RdpViewport) =>
    invoke<void>('rdp_session_set_bounds', { sessionId, viewport }),
  showRdp: (sessionId: string) => invoke<void>('rdp_session_show', { sessionId }),
  hideRdp: (sessionId: string) => invoke<void>('rdp_session_hide', { sessionId }),
  listenRdpState: (sessionId: string, fn: (event: RdpLifecycleEvent) => void): Promise<UnlistenFn> =>
    listen<RdpLifecycleEvent>(`rdp://${sessionId}/state`, (e) => fn(e.payload)),
  listenRdpExit: (sessionId: string, fn: (reason: string) => void): Promise<UnlistenFn> =>
    listen<string>(`rdp://${sessionId}/exit`, (e) => fn(e.payload)),
  importMremote: (request: ImportRequest): Promise<ImportReport> =>
    invoke('import_mremoteng', { path: request.path, mode: request.mode }),
  exportMremote: (path: string) => invoke('export_mremoteng', { path, scope: null }),
  listenStdout: (sessionId: string, fn: (data: string) => void): Promise<UnlistenFn> =>
    listen<string>(`ssh://${sessionId}/stdout`, (event) => fn(event.payload)),
  listenExit: (sessionId: string, fn: (code: number) => void): Promise<UnlistenFn> =>
    listen<number>(`ssh://${sessionId}/exit`, (event) => fn(event.payload)),
  listenErrors: (fn: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>('app://errors', (event) => fn(event.payload))
};
