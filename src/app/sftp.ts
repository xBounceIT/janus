import type { FileEntry, FileListResult } from '../types';
import type { FilePaneSide, SessionTab, SftpModalState, SftpPaneState } from './types';

export type SftpControllerDeps = {
  tabs: Map<string, SessionTab>;
  api: {
    openSftp: (sshSessionId: string) => Promise<{ sftpSessionId: string; remoteCwd: string }>;
    closeSftp: (sshSessionId: string, sftpSessionId: string) => Promise<unknown>;
    listSftp: (request: { sshSessionId: string; sftpSessionId: string; path: string }) => Promise<FileListResult>;
    localFsList: (path: string) => Promise<FileListResult>;
    localFsNewFile: (path: string) => Promise<unknown>;
    localFsNewFolder: (path: string) => Promise<unknown>;
    sftpNewFile: (request: { sshSessionId: string; sftpSessionId: string; path: string }) => Promise<unknown>;
    sftpNewFolder: (request: { sshSessionId: string; sftpSessionId: string; path: string }) => Promise<unknown>;
    localFsRename: (oldPath: string, newPath: string) => Promise<unknown>;
    sftpRename: (request: { sshSessionId: string; sftpSessionId: string; oldPath: string; newPath: string }) => Promise<unknown>;
    localFsDelete: (path: string, isDir: boolean) => Promise<unknown>;
    sftpDelete: (request: { sshSessionId: string; sftpSessionId: string; path: string; isDir: boolean }) => Promise<unknown>;
    sftpUploadFile: (request: {
      sshSessionId: string;
      sftpSessionId: string;
      localPath: string;
      remotePath: string;
      overwrite: boolean;
    }) => Promise<unknown>;
    sftpDownloadFile: (request: {
      sshSessionId: string;
      sftpSessionId: string;
      localPath: string;
      remotePath: string;
      overwrite: boolean;
    }) => Promise<unknown>;
  };
  showModal: (title: string, buildContent: (card: HTMLDivElement) => void) => void;
  hideModal: () => void;
  setModalOnHide: (handler: (() => void | Promise<void>) | null) => void;
  getActiveSftpModal: () => SftpModalState | null;
  setActiveSftpModal: (state: SftpModalState | null) => void;
  writeStatus: (message: string) => void;
  formatError: (error: unknown) => string;
  escapeHtml: (input: string) => string;
  sftpToolbarSvg: (
    kind: 'file-plus' | 'folder-plus' | 'rename' | 'delete' | 'upload' | 'download' | 'refresh' | 'up'
  ) => string;
  sftpEntryIcon: (kind: FileEntry['kind']) => string;
};

export type SftpController = {
  openSftpModalForTab: (tabKey: string) => Promise<void>;
};

export function createSftpController(deps: SftpControllerDeps): SftpController {
  const getActive = deps.getActiveSftpModal;
  const setActive = deps.setActiveSftpModal;

  function createSftpPane(side: FilePaneSide): SftpPaneState {
    return {
      side,
      cwd: '',
      entries: [],
      selectedPath: null,
      selectedKind: null,
      loading: false,
      rootEl: null,
      pathEl: null,
      listEl: null,
    };
  }

  async function openSftpModalForTab(tabKey: string): Promise<void> {
    const tab = deps.tabs.get(tabKey);
    if (!tab || tab.kind !== 'ssh' || !tab.sessionId) {
      deps.writeStatus('SSH tab is no longer available');
      return;
    }
    if (tab.sshState !== 'connected') {
      deps.writeStatus('SFTP is available only while the SSH tab is connected');
      return;
    }

    if (getActive()?.tabKey === tabKey) {
      return;
    }

    if (getActive()) {
      deps.hideModal();
    }

    const opened = await deps.api.openSftp(tab.sessionId);

    const state: SftpModalState = {
      tabKey,
      sshSessionId: tab.sessionId,
      connectionName: tab.title,
      sftpSessionId: opened.sftpSessionId,
      closing: false,
      activePane: 'remote',
      local: createSftpPane('local'),
      remote: createSftpPane('remote'),
      card: null,
      statusEl: null,
    };

    deps.showModal(`SFTP - ${tab.title}`, (card) => {
      setActive(state);
      state.card = card;
      card.classList.add('sftp-modal');

      const toolbar = document.createElement('div');
      toolbar.className = 'sftp-toolbar';

      const transferRow = document.createElement('div');
      transferRow.className = 'sftp-transfer-row';

      const layout = document.createElement('div');
      layout.className = 'sftp-layout';

      const footer = document.createElement('div');
      footer.className = 'sftp-footer';

      const statusEl = document.createElement('p');
      statusEl.className = 'sftp-status';
      state.statusEl = statusEl;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn btn-primary';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', deps.hideModal);

      footer.append(statusEl, closeBtn);

      const actionButtons: Array<{ label: string; icon: string; onClick: () => void }> = [
        { label: 'New File', icon: deps.sftpToolbarSvg('file-plus'), onClick: () => void sftpCreateItem(state, 'file') },
        {
          label: 'New Folder',
          icon: deps.sftpToolbarSvg('folder-plus'),
          onClick: () => void sftpCreateItem(state, 'folder'),
        },
        { label: 'Rename', icon: deps.sftpToolbarSvg('rename'), onClick: () => void sftpRenameSelected(state) },
        { label: 'Delete', icon: deps.sftpToolbarSvg('delete'), onClick: () => void sftpDeleteSelected(state) },
      ];

      for (const action of actionButtons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sftp-toolbar-btn';
        btn.innerHTML = `${action.icon}<span>${deps.escapeHtml(action.label)}</span>`;
        btn.addEventListener('click', action.onClick);
        toolbar.appendChild(btn);
      }

      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'sftp-toolbar-btn';
      uploadBtn.innerHTML = `${deps.sftpToolbarSvg('upload')}<span>Upload -></span>`;
      uploadBtn.addEventListener('click', () => void sftpTransfer(state, 'upload'));

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'sftp-toolbar-btn';
      downloadBtn.innerHTML = `${deps.sftpToolbarSvg('download')}<span>&larr; Download</span>`;
      downloadBtn.addEventListener('click', () => void sftpTransfer(state, 'download'));

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'sftp-toolbar-btn';
      refreshBtn.innerHTML = `${deps.sftpToolbarSvg('refresh')}<span>Refresh</span>`;
      refreshBtn.addEventListener('click', () => void sftpRefreshBothPanes(state));

      transferRow.append(uploadBtn, downloadBtn, refreshBtn);

      layout.append(
        buildSftpPaneUi(state, state.local, 'My PC'),
        buildSftpPaneUi(state, state.remote, state.connectionName),
      );

      card.append(toolbar, transferRow, layout, footer);

      void sftpRefreshBothPanes(state, '', opened.remoteCwd);
    });

    deps.setModalOnHide(() => {
      if (getActive() !== state) return;
      if (state.closing) return;
      state.closing = true;
      const sshSessionId = state.sshSessionId;
      const sftpSessionId = state.sftpSessionId;
      setActive(null);
      if (sftpSessionId) {
        void deps.api.closeSftp(sshSessionId, sftpSessionId).catch(() => undefined);
        state.sftpSessionId = null;
      }
    });
  }

  function buildSftpPaneUi(state: SftpModalState, pane: SftpPaneState, title: string): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'sftp-pane';
    root.dataset.side = pane.side;
    root.addEventListener('click', () => {
      sftpSetActivePane(state, pane.side);
    });

    const header = document.createElement('div');
    header.className = 'sftp-pane-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'sftp-pane-title';
    titleEl.textContent = title;

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn btn-sm btn-ghost sftp-pane-up';
    upBtn.innerHTML = `${deps.sftpToolbarSvg('up')}<span>Up</span>`;
    upBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void sftpNavigateParent(state, pane.side);
    });

    header.append(titleEl, upBtn);

    const pathRow = document.createElement('div');
    pathRow.className = 'sftp-path-row';

    const pathEl = document.createElement('input');
    pathEl.type = 'text';
    pathEl.className = 'sftp-path-input';
    pathEl.readOnly = true;
    pathEl.value = '';

    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'btn btn-sm';
    goBtn.textContent = 'Open';
    goBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextPath = pathEl.value.trim();
      if (!nextPath) return;
      void sftpLoadPane(state, pane.side, nextPath);
    });

    pathEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      pathEl.readOnly = false;
      pathEl.focus();
      pathEl.select();
    });
    pathEl.addEventListener('blur', () => {
      pathEl.readOnly = true;
      pathEl.value = pane.cwd;
    });
    pathEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        pathEl.readOnly = true;
        void sftpLoadPane(state, pane.side, pathEl.value.trim());
      } else if (event.key === 'Escape') {
        pathEl.readOnly = true;
        pathEl.value = pane.cwd;
        pathEl.blur();
      }
    });

    pathRow.append(pathEl, goBtn);

    const listEl = document.createElement('div');
    listEl.className = 'sftp-file-list';

    root.append(header, pathRow, listEl);

    pane.rootEl = root;
    pane.pathEl = pathEl;
    pane.listEl = listEl;

    sftpSetActivePane(state, state.activePane);
    sftpRenderPane(state, pane);

    return root;
  }

  function sftpSetStatus(state: SftpModalState, message: string, kind: 'info' | 'error' = 'info'): void {
    if (getActive() !== state || !state.statusEl) return;
    state.statusEl.textContent = message;
    state.statusEl.classList.toggle('error', kind === 'error');
  }

  function sftpGetPane(state: SftpModalState, side: FilePaneSide): SftpPaneState {
    return side === 'local' ? state.local : state.remote;
  }

  function sftpSetActivePane(state: SftpModalState, side: FilePaneSide): void {
    state.activePane = side;
    state.local.rootEl?.classList.toggle('active', side === 'local');
    state.remote.rootEl?.classList.toggle('active', side === 'remote');
  }

  function sftpSelectPaneEntry(state: SftpModalState, side: FilePaneSide, entry: FileEntry | null): void {
    const pane = sftpGetPane(state, side);
    sftpSetActivePane(state, side);
    pane.selectedPath = entry?.path ?? null;
    pane.selectedKind = entry?.kind ?? null;
    sftpRenderPane(state, pane);
  }

  function sftpRenderPane(state: SftpModalState, pane: SftpPaneState): void {
    if (!pane.listEl) return;

    if (pane.pathEl) {
      pane.pathEl.value = pane.cwd;
    }

    pane.listEl.replaceChildren();
    const frag = document.createDocumentFragment();

    if (pane.loading) {
      const loading = document.createElement('div');
      loading.className = 'sftp-file-row sftp-file-row-empty';
      loading.textContent = 'Loading...';
      frag.appendChild(loading);
      pane.listEl.appendChild(frag);
      return;
    }

    const parentPath = pane.side === 'remote' ? sftpRemoteParentPath(pane.cwd) : sftpLocalParentPath(pane.cwd);
    if (parentPath) {
      const parentRow = document.createElement('button');
      parentRow.type = 'button';
      parentRow.className = 'sftp-file-row parent';
      parentRow.innerHTML = `<span class=\"sftp-file-icon\">${deps.sftpEntryIcon('dir')}</span><span class=\"sftp-file-name\">..</span>`;
      parentRow.addEventListener('click', () => {
        sftpSetActivePane(state, pane.side);
      });
      parentRow.addEventListener('dblclick', () => {
        void sftpLoadPane(state, pane.side, parentPath);
      });
      frag.appendChild(parentRow);
    }

    if (pane.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sftp-file-row sftp-file-row-empty';
      empty.textContent = 'Empty';
      frag.appendChild(empty);
    } else {
      for (const entry of pane.entries) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `sftp-file-row${pane.selectedPath === entry.path ? ' selected' : ''}`;

        const icon = document.createElement('span');
        icon.className = 'sftp-file-icon';
        icon.innerHTML = deps.sftpEntryIcon(entry.kind);

        const name = document.createElement('span');
        name.className = 'sftp-file-name';
        name.textContent = entry.name;

        const meta = document.createElement('span');
        meta.className = 'sftp-file-meta';
        meta.textContent =
          entry.kind === 'dir'
            ? 'folder'
            : entry.size != null
              ? `${entry.size} B`
              : entry.kind;

        row.append(icon, name, meta);
        row.addEventListener('click', () => sftpSelectPaneEntry(state, pane.side, entry));
        row.addEventListener('dblclick', () => {
          sftpSelectPaneEntry(state, pane.side, entry);
          if (entry.kind === 'dir') {
            void sftpLoadPane(state, pane.side, entry.path);
          }
        });

        frag.appendChild(row);
      }
    }

    pane.listEl.appendChild(frag);
  }

  async function sftpRefreshBothPanes(
    state: SftpModalState,
    localPath = state.local.cwd || '',
    remotePath = state.remote.cwd || '.',
  ): Promise<void> {
    await Promise.all([sftpLoadPane(state, 'local', localPath), sftpLoadPane(state, 'remote', remotePath)]);
  }

  async function sftpLoadPane(state: SftpModalState, side: FilePaneSide, path: string): Promise<void> {
    if (getActive() !== state || state.closing) return;
    const pane = sftpGetPane(state, side);
    pane.loading = true;
    sftpRenderPane(state, pane);

    try {
      let result: FileListResult;
      if (side === 'local') {
        result = await deps.api.localFsList(path);
      } else {
        if (!state.sftpSessionId) throw new Error('SFTP session is closed');
        result = await deps.api.listSftp({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId,
          path,
        });
      }

      if (getActive() !== state || state.closing) return;
      pane.cwd = result.cwd;
      pane.entries = result.entries;
      pane.loading = false;

      if (pane.selectedPath && !pane.entries.some((entry) => entry.path === pane.selectedPath)) {
        pane.selectedPath = null;
        pane.selectedKind = null;
      }

      sftpRenderPane(state, pane);
    } catch (error) {
      pane.loading = false;
      sftpRenderPane(state, pane);
      sftpSetStatus(state, deps.formatError(error), 'error');
    }
  }

  async function sftpNavigateParent(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
    const parent = side === 'remote' ? sftpRemoteParentPath(pane.cwd) : sftpLocalParentPath(pane.cwd);
    if (!parent) return;
    await sftpLoadPane(state, side, parent);
  }

  async function sftpCreateItem(state: SftpModalState, kind: 'file' | 'folder'): Promise<void> {
    const pane = sftpGetPane(state, state.activePane);
    if (!pane.cwd) return;
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
      sftpSetStatus(state, 'Name cannot contain path separators', 'error');
      return;
    }

    const fullPath =
      pane.side === 'local' ? sftpLocalJoinPath(pane.cwd, trimmed) : sftpRemoteJoinPath(pane.cwd, trimmed);

    try {
      if (pane.side === 'local') {
        if (kind === 'file') {
          await deps.api.localFsNewFile(fullPath);
        } else {
          await deps.api.localFsNewFolder(fullPath);
        }
      } else {
        if (!state.sftpSessionId) throw new Error('SFTP session is closed');
        const request = {
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId,
          path: fullPath,
        };
        if (kind === 'file') {
          await deps.api.sftpNewFile(request);
        } else {
          await deps.api.sftpNewFolder(request);
        }
      }
      sftpSetStatus(state, `${kind === 'file' ? 'File' : 'Folder'} created`);
      await sftpLoadPane(state, pane.side, pane.cwd);
    } catch (error) {
      sftpSetStatus(state, deps.formatError(error), 'error');
    }
  }

  async function sftpRenameSelected(state: SftpModalState): Promise<void> {
    const pane = sftpGetPane(state, state.activePane);
    const entry = pane.entries.find((item) => item.path === pane.selectedPath);
    if (!entry) {
      sftpSetStatus(state, 'Select a file or folder to rename', 'error');
      return;
    }
    const nextName = window.prompt('Rename to', entry.name);
    if (nextName == null) return;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === entry.name) return;
    if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
      sftpSetStatus(state, 'Name cannot contain path separators', 'error');
      return;
    }

    const parent = pane.side === 'local' ? sftpLocalParentPath(entry.path) : sftpRemoteParentPath(entry.path);
    const newPath =
      pane.side === 'local'
        ? sftpLocalJoinPath(parent ?? pane.cwd, trimmed)
        : sftpRemoteJoinPath(parent ?? pane.cwd, trimmed);

    try {
      if (pane.side === 'local') {
        await deps.api.localFsRename(entry.path, newPath);
      } else {
        if (!state.sftpSessionId) throw new Error('SFTP session is closed');
        await deps.api.sftpRename({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId,
          oldPath: entry.path,
          newPath,
        });
      }
      sftpSetStatus(state, 'Renamed');
      await sftpLoadPane(state, pane.side, pane.cwd);
    } catch (error) {
      sftpSetStatus(state, deps.formatError(error), 'error');
    }
  }

  async function sftpDeleteSelected(state: SftpModalState): Promise<void> {
    const pane = sftpGetPane(state, state.activePane);
    const entry = pane.entries.find((item) => item.path === pane.selectedPath);
    if (!entry) {
      sftpSetStatus(state, 'Select a file or folder to delete', 'error');
      return;
    }

    const confirmed = window.confirm(`Delete ${entry.kind === 'dir' ? 'folder' : 'file'} "${entry.name}"?`);
    if (!confirmed) return;

    try {
      if (pane.side === 'local') {
        await deps.api.localFsDelete(entry.path, entry.kind === 'dir');
      } else {
        if (!state.sftpSessionId) throw new Error('SFTP session is closed');
        await deps.api.sftpDelete({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId,
          path: entry.path,
          isDir: entry.kind === 'dir',
        });
      }
      sftpSetStatus(state, 'Deleted');
      await sftpLoadPane(state, pane.side, pane.cwd);
    } catch (error) {
      sftpSetStatus(state, deps.formatError(error), 'error');
    }
  }

  async function sftpTransfer(state: SftpModalState, direction: 'upload' | 'download'): Promise<void> {
    if (!state.sftpSessionId) {
      sftpSetStatus(state, 'SFTP session is closed', 'error');
      return;
    }

    const sourcePane = direction === 'upload' ? state.local : state.remote;
    const targetPane = direction === 'upload' ? state.remote : state.local;
    const sourceEntry = sourcePane.entries.find((item) => item.path === sourcePane.selectedPath);

    if (!sourceEntry) {
      sftpSetStatus(state, `Select a ${direction === 'upload' ? 'local' : 'remote'} file first`, 'error');
      return;
    }
    if (sourceEntry.kind !== 'file') {
      sftpSetStatus(state, 'Directory transfer is not supported in v1 (file-only)', 'error');
      return;
    }
    if (!targetPane.cwd) {
      sftpSetStatus(state, 'Target folder is unavailable', 'error');
      return;
    }

    const fileName = sftpBaseName(sourceEntry.path);
    const localPath = direction === 'upload' ? sourceEntry.path : sftpLocalJoinPath(targetPane.cwd, fileName);
    const remotePath = direction === 'upload' ? sftpRemoteJoinPath(targetPane.cwd, fileName) : sourceEntry.path;

    const runTransfer = async (overwrite: boolean): Promise<void> => {
      if (direction === 'upload') {
        await deps.api.sftpUploadFile({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId!,
          localPath,
          remotePath,
          overwrite,
        });
      } else {
        await deps.api.sftpDownloadFile({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId!,
          localPath,
          remotePath,
          overwrite,
        });
      }
    };

    try {
      await runTransfer(false);
    } catch (error) {
      const message = deps.formatError(error);
      if (message.toLowerCase().includes('already exists')) {
        const ok = window.confirm(
          `Overwrite existing ${direction === 'upload' ? 'remote' : 'local'} file "${fileName}"?`,
        );
        if (!ok) return;
        try {
          await runTransfer(true);
        } catch (retryError) {
          sftpSetStatus(state, deps.formatError(retryError), 'error');
          return;
        }
      } else {
        sftpSetStatus(state, message, 'error');
        return;
      }
    }

    sftpSetStatus(state, direction === 'upload' ? 'Upload complete' : 'Download complete');
    await sftpRefreshBothPanes(state, state.local.cwd, state.remote.cwd);
  }

  function sftpRemoteJoinPath(base: string, name: string): string {
    if (!base || base === '.') return name;
    if (base === '/') return `/${name}`;
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
  }

  function sftpRemoteParentPath(path: string): string | null {
    if (!path || path === '.' || path === '/') return null;
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const idx = trimmed.lastIndexOf('/');
    if (idx < 0) return null;
    if (idx === 0) return '/';
    return trimmed.slice(0, idx);
  }

  function sftpLocalJoinPath(base: string, name: string): string {
    if (!base) return name;
    if (/[\\/]$/.test(base)) return `${base}${name}`;
    if (/^[A-Za-z]:$/.test(base)) return `${base}\\${name}`;
    const sep = base.includes('\\') ? '\\' : '/';
    return `${base}${sep}${name}`;
  }

  function sftpLocalParentPath(path: string): string | null {
    if (!path) return null;
    const trimmed = path.replace(/[\\/]+$/, '');
    if (!trimmed) return null;
    if (/^[A-Za-z]:$/.test(trimmed)) return null;
    if (/^[A-Za-z]:\\$/.test(path)) return null;
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx < 0) return null;
    if (idx === 0) return '/';
    const parent = trimmed.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
    return parent || null;
  }

  function sftpBaseName(path: string): string {
    const normalized = path.replace(/[\\/]+$/, '');
    const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
  }

  return {
    openSftpModalForTab,
  };
}
