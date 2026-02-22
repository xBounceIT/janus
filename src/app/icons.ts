import type { FileEntryKind, NodeKind } from '../types';

export function faIcon(name: string): string {
  return `<i class="${name}" aria-hidden="true"></i>`;
}

export function svgIcon(kind: NodeKind): string {
  if (kind === 'folder') return faIcon('fa-solid fa-folder');
  if (kind === 'ssh') return faIcon('fa-solid fa-terminal');
  return faIcon('fa-solid fa-desktop');
}

export function disconnectIcon(): string {
  return faIcon('fa-solid fa-circle-xmark');
}

export function reconnectIcon(): string {
  return faIcon('fa-solid fa-rotate-right');
}

export function duplicateIcon(): string {
  return faIcon('fa-solid fa-clone');
}

export function sftpIcon(): string {
  return faIcon('fa-solid fa-right-left');
}

export function sftpEntryIcon(kind: FileEntryKind): string {
  if (kind === 'dir') return faIcon('fa-solid fa-folder');
  if (kind === 'symlink') return faIcon('fa-solid fa-link');
  return faIcon('fa-regular fa-file');
}

export function sftpToolbarSvg(
  kind: 'file-plus' | 'folder-plus' | 'rename' | 'delete' | 'upload' | 'download' | 'refresh' | 'up'
): string {
  const map: Record<typeof kind, string> = {
    'file-plus': 'fa-solid fa-file-circle-plus',
    'folder-plus': 'fa-solid fa-folder-plus',
    rename: 'fa-solid fa-pen',
    delete: 'fa-solid fa-trash',
    upload: 'fa-solid fa-upload',
    download: 'fa-solid fa-download',
    refresh: 'fa-solid fa-arrows-rotate',
    up: 'fa-solid fa-arrow-up',
  };
  return faIcon(map[kind]);
}

export function vaultLockIconSvg(locked: boolean): string {
  return locked ? faIcon('fa-solid fa-lock') : faIcon('fa-solid fa-lock-open');
}
