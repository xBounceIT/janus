import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ConnectionNode,
  ConnectionUpsert,
  FolderUpsert,
  ImportReport,
  ImportRequest,
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
    invoke<string>('ssh_session_open', { connectionId, sessionOpts }),
  writeSsh: (sessionId: string, data: string) => invoke('ssh_session_write', { sessionId, data }),
  resizeSsh: (sessionId: string, cols: number, rows: number) =>
    invoke('ssh_session_resize', { sessionId, cols, rows }),
  closeSsh: (sessionId: string) => invoke('ssh_session_close', { sessionId }),
  launchRdp: (connectionId: string) => invoke('rdp_launch', { connectionId, launchOpts: null }),
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
