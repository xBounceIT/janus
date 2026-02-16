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
}
