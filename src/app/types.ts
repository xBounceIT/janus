import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { FileEntry, FileEntryKind } from '../types';

export type SshSessionTab = {
  kind: 'ssh';
  connectionId: string;
  sessionId: string | null;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  sshState: 'connecting' | 'connected' | 'exited';
  exitCode: number | null;
  cleanup: Array<() => void>;
};

export type RdpSessionTab = {
  kind: 'rdp';
  connectionId: string;
  sessionId: string | null;
  baseTitle: string;
  title: string;
  root: HTMLDivElement;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  rdpState: 'connecting' | 'connected' | 'error';
  cleanup: Array<() => void>;
};

export type SessionTab = SshSessionTab | RdpSessionTab;
export type PreferencesSectionId = 'ui' | 'security' | 'advanced';
export type FilePaneSide = 'local' | 'remote';

export type PreferencesSectionDefinition = {
  id: PreferencesSectionId;
  label: string;
  icon: string;
  description: string;
  placeholders: Array<{ label: string; hint: string }>;
};

export type SftpPaneState = {
  side: FilePaneSide;
  cwd: string;
  entries: FileEntry[];
  sortKey: 'name' | 'size';
  selectedPath: string | null;
  selectedKind: FileEntryKind | null;
  loading: boolean;
  rootEl: HTMLDivElement | null;
  pathEl: HTMLInputElement | null;
  listEl: HTMLDivElement | null;
  dropOverlayEl: HTMLDivElement | null;
};

export type SftpTransferUiState = {
  mode: 'single' | 'batch-upload';
  direction: 'upload' | 'download';
  label: string;
  totalBytes: number | null;
  completedBytesBase: number;
  currentFileBytes: number;
  currentFileTotalBytes: number | null;
  startedAtMs: number;
  lastSampleAtMs: number;
  lastSampleTotalBytes: number;
  speedBytesPerSec: number;
  percent: number;
  currentFileKey: string | null;
  fileTotals: Map<string, number>;
  fileCompleted: Set<string>;
};

export type SftpModalState = {
  tabKey: string;
  sshSessionId: string;
  connectionName: string;
  sftpSessionId: string | null;
  closing: boolean;
  activePane: FilePaneSide;
  local: SftpPaneState;
  remote: SftpPaneState;
  card: HTMLDivElement | null;
  statusEl: HTMLParagraphElement | null;
  transferStripEl: HTMLDivElement | null;
  transferBarEl: HTMLDivElement | null;
  transferLabelEl: HTMLDivElement | null;
  transferMetaEl: HTMLDivElement | null;
  transferState: SftpTransferUiState | null;
  transferProgressUnlisten: (() => void) | null;
  dragDropUnlisten: (() => void) | null;
  remoteDropHover: boolean;
  localDropReject: boolean;
  dropTransferRunning: boolean;
};
