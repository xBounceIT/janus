export type NodeKind = 'folder' | 'ssh' | 'rdp';

export interface ConnectionNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  orderIndex: number;
  ssh: SshConfig | null;
  rdp: RdpConfig | null;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  strictHostKey: boolean;
  keyPath?: string | null;
  authRef?: string | null;
  keyPassphraseRef?: string | null;
}

export interface RdpConfig {
  host: string;
  port: number;
  username?: string | null;
  domain?: string | null;
  screenMode: number;
  width?: number | null;
  height?: number | null;
  credentialRef?: string | null;
}

export interface FolderUpsert {
  id: string;
  parentId: string | null;
  name: string;
  orderIndex: number;
}

export interface SshConfigInput {
  host: string;
  port: number;
  username: string;
  strictHostKey: boolean;
  keyPath?: string | null;
  password?: string | null;
  keyPassphrase?: string | null;
}

export interface RdpConfigInput {
  host: string;
  port: number;
  username?: string | null;
  domain?: string | null;
  screenMode: number;
  width?: number | null;
  height?: number | null;
  password?: string | null;
}

export interface ConnectionUpsert {
  id: string;
  parentId: string | null;
  kind: 'ssh' | 'rdp';
  name: string;
  orderIndex: number;
  ssh?: SshConfigInput | null;
  rdp?: RdpConfigInput | null;
}

export interface ImportRequest {
  path: string;
  mode: 'dry_run' | 'apply';
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

export interface SessionOptions {
  cols?: number;
  rows?: number;
  sessionId?: string;
}

export interface TcpProbeResult {
  host: string;
  reachable: boolean;
}

export interface SshSessionOpenedResult {
  type: 'opened';
  sessionId: string;
}

export interface SshHostKeyMismatchResult {
  type: 'hostKeyMismatch';
  token: string;
  host: string;
  port: number;
  storedKeyType: string;
  storedFingerprint: string;
  presentedKeyType: string;
  presentedFingerprint: string;
  warning: string;
}

export type SshSessionOpenResult = SshSessionOpenedResult | SshHostKeyMismatchResult;

export type FileEntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  kind: FileEntryKind;
  size?: number | null;
  modifiedAt?: number | null;
  owner?: string | null;
  permissions?: number | null;
  hidden: boolean;
}

export interface FileListResult {
  cwd: string;
  entries: FileEntry[];
}

export interface SftpSessionOpenResult {
  sftpSessionId: string;
  remoteCwd: string;
}

export interface SftpListRequest {
  sshSessionId: string;
  sftpSessionId: string;
  path: string;
}

export interface SftpPathRequest {
  sshSessionId: string;
  sftpSessionId: string;
  path: string;
}

export interface SftpRenameRequest {
  sshSessionId: string;
  sftpSessionId: string;
  oldPath: string;
  newPath: string;
}

export interface SftpDeleteRequest {
  sshSessionId: string;
  sftpSessionId: string;
  path: string;
  isDir: boolean;
}

export interface SftpTransferRequest {
  sshSessionId: string;
  sftpSessionId: string;
  localPath: string;
  remotePath: string;
  overwrite?: boolean;
}

export interface SftpTransferProgressEvent {
  direction: 'upload' | 'download';
  phase: 'start' | 'progress' | 'complete';
  localPath: string;
  remotePath: string;
  bytesTransferred: number;
  totalBytes?: number | null;
}

export interface RdpViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RdpLifecycleEvent =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'loginComplete' }
  | { type: 'disconnected'; reason: number }
  | { type: 'fatalError'; errorCode: number }
  | { type: 'logonError'; errorCode: number }
  | { type: 'hostInitFailed'; stage: string; hresult: number | null; message: string };
