import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
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

type SftpDroppedUploadStats = {
  droppedItems: number;
  filesUploaded: number;
  foldersCreated: number;
  skipped: number;
  errors: number;
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
      dropOverlayEl: null,
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
      dragDropUnlisten: null,
      remoteDropHover: false,
      dropTransferRunning: false,
    };

    deps.showModal(`SFTP - ${tab.title}`, (card) => {
      setActive(state);
      state.card = card;
      card.classList.add('sftp-modal');

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

      layout.append(
        buildSftpPaneUi(state, state.local, 'My PC'),
        buildSftpPaneUi(state, state.remote, state.connectionName),
      );

      card.append(layout, footer);

      void sftpAttachDragDropListener(state);
      void sftpRefreshBothPanes(state, '', opened.remoteCwd);
    });

    deps.setModalOnHide(() => {
      if (getActive() !== state) return;
      if (state.closing) return;
      state.closing = true;
      const sshSessionId = state.sshSessionId;
      const sftpSessionId = state.sftpSessionId;
      sftpSetRemoteDropHover(state, false);
      const dragDropUnlisten = state.dragDropUnlisten;
      state.dragDropUnlisten = null;
      if (dragDropUnlisten) {
        try {
          dragDropUnlisten();
        } catch {
          // Ignore teardown errors during modal close.
        }
      }
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

    const actionsRow = document.createElement('div');
    actionsRow.className = 'sftp-pane-actions';

    const actions: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'New File', icon: deps.sftpToolbarSvg('file-plus'), onClick: () => void sftpCreateItem(state, pane.side, 'file') },
      {
        label: 'New Folder',
        icon: deps.sftpToolbarSvg('folder-plus'),
        onClick: () => void sftpCreateItem(state, pane.side, 'folder'),
      },
      { label: 'Rename', icon: deps.sftpToolbarSvg('rename'), onClick: () => void sftpRenameSelected(state, pane.side) },
      { label: 'Delete', icon: deps.sftpToolbarSvg('delete'), onClick: () => void sftpDeleteSelected(state, pane.side) },
      pane.side === 'local'
        ? { label: 'Upload', icon: deps.sftpToolbarSvg('upload'), onClick: () => void sftpTransfer(state, 'upload') }
        : { label: 'Download', icon: deps.sftpToolbarSvg('download'), onClick: () => void sftpTransfer(state, 'download') },
      { label: 'Refresh', icon: deps.sftpToolbarSvg('refresh'), onClick: () => void sftpRefreshPane(state, pane.side) },
    ];

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sftp-pane-action-btn';
      btn.title = action.label;
      btn.setAttribute('aria-label', action.label);
      btn.innerHTML = action.icon;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        sftpSetActivePane(state, pane.side);
        action.onClick();
      });
      actionsRow.appendChild(btn);
    }

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

    pathEl.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpSetActivePane(state, pane.side);
      if (!pathEl.readOnly) return;
      pathEl.readOnly = false;
      pathEl.focus();
      pathEl.select();
    });
    pathEl.addEventListener('blur', (event) => {
      pathEl.readOnly = true;
      if (event.relatedTarget === goBtn) return;
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

    let dropOverlayEl: HTMLDivElement | null = null;
    if (pane.side === 'remote') {
      dropOverlayEl = document.createElement('div');
      dropOverlayEl.className = 'sftp-pane-drop-overlay';
      dropOverlayEl.setAttribute('aria-hidden', 'true');

      const overlayInner = document.createElement('div');
      overlayInner.className = 'sftp-pane-drop-overlay-inner';

      const plus = document.createElement('div');
      plus.className = 'sftp-pane-drop-plus';
      plus.textContent = '+';

      const subtitle = document.createElement('div');
      subtitle.className = 'sftp-pane-drop-subtitle';
      subtitle.textContent = 'Drop files or folders here to upload';

      overlayInner.append(plus, subtitle);
      dropOverlayEl.appendChild(overlayInner);
      root.append(header, actionsRow, pathRow, listEl, dropOverlayEl);
    } else {
      root.append(header, actionsRow, pathRow, listEl);
    }

    pane.rootEl = root;
    pane.pathEl = pathEl;
    pane.listEl = listEl;
    pane.dropOverlayEl = dropOverlayEl;

    sftpSetActivePane(state, state.activePane);
    if (pane.side === 'remote') {
      sftpSetRemoteDropHover(state, state.remoteDropHover);
    }
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

  function sftpSetRemoteDropHover(state: SftpModalState, hovering: boolean): void {
    state.remoteDropHover = hovering;
    state.remote.rootEl?.classList.toggle('drop-hover', hovering);
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
    if (pane.side === 'remote') {
      pane.rootEl?.classList.toggle('drop-hover', state.remoteDropHover);
    }

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

  async function sftpRefreshPane(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
    await sftpLoadPane(state, side, pane.cwd || (side === 'remote' ? '.' : ''));
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

  async function sftpCreateItem(state: SftpModalState, side: FilePaneSide, kind: 'file' | 'folder'): Promise<void> {
    const pane = sftpGetPane(state, side);
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

  async function sftpRenameSelected(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
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

  async function sftpDeleteSelected(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
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

  async function sftpAttachDragDropListener(state: SftpModalState): Promise<void> {
    try {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        sftpHandleDragDropEvent(state, event.payload);
      });

      if (getActive() !== state || state.closing) {
        unlisten();
        return;
      }

      if (state.dragDropUnlisten) {
        unlisten();
        return;
      }

      state.dragDropUnlisten = unlisten;
    } catch (error) {
      sftpSetStatus(state, `File drop is unavailable: ${deps.formatError(error)}`, 'error');
    }
  }

  function sftpHandleDragDropEvent(state: SftpModalState, payload: DragDropEvent): void {
    if (getActive() !== state || state.closing) return;

    if (payload.type === 'leave') {
      sftpSetRemoteDropHover(state, false);
      return;
    }

    const insideRemotePane = sftpRemotePaneContainsPhysicalPoint(state, payload.position);

    if (payload.type === 'enter' || payload.type === 'over') {
      const canHover = insideRemotePane && Boolean(state.remote.cwd) && !state.dropTransferRunning;
      sftpSetRemoteDropHover(state, canHover);
      if (canHover) {
        sftpSetActivePane(state, 'remote');
      }
      return;
    }

    sftpSetRemoteDropHover(state, false);
    if (!insideRemotePane) return;
    void sftpHandleRemoteDropPaths(state, payload.paths);
  }

  function sftpRemotePaneContainsPhysicalPoint(
    state: SftpModalState,
    position: { x: number; y: number },
  ): boolean {
    const root = state.remote.rootEl;
    if (!root) return false;

    const rect = root.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const x = position.x / scale;
    const y = position.y / scale;

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  async function sftpHandleRemoteDropPaths(state: SftpModalState, rawPaths: string[]): Promise<void> {
    if (state.dropTransferRunning) {
      sftpSetStatus(state, 'A drop upload is already in progress', 'error');
      return;
    }
    if (!state.sftpSessionId) {
      sftpSetStatus(state, 'SFTP session is closed', 'error');
      return;
    }
    if (!state.remote.cwd) {
      sftpSetStatus(state, 'Target folder is unavailable', 'error');
      return;
    }

    const paths = rawPaths.map((path) => path.trim()).filter((path) => path.length > 0);
    if (paths.length === 0) {
      sftpSetStatus(state, 'No dropped files were detected', 'error');
      return;
    }

    state.dropTransferRunning = true;
    sftpSetActivePane(state, 'remote');

    const stats: SftpDroppedUploadStats = {
      droppedItems: paths.length,
      filesUploaded: 0,
      foldersCreated: 0,
      skipped: 0,
      errors: 0,
    };

    sftpSetStatus(state, `Uploading ${paths.length} dropped item${paths.length === 1 ? '' : 's'}...`);

    try {
      for (const path of paths) {
        sftpAssertDropUploadReady(state);
        try {
          await sftpUploadDroppedItem(state, path, state.remote.cwd, stats);
        } catch (error) {
          stats.errors += 1;
          if (sftpIsSessionClosedError(error)) {
            throw error;
          }
        }
      }

      if (getActive() === state && !state.closing) {
        await sftpRefreshBothPanes(state, state.local.cwd, state.remote.cwd);
      }

      const summary = sftpFormatDroppedUploadSummary(stats);
      sftpSetStatus(state, summary, stats.errors > 0 ? 'error' : 'info');
    } catch (error) {
      sftpSetStatus(state, deps.formatError(error), 'error');
    } finally {
      state.dropTransferRunning = false;
      sftpSetRemoteDropHover(state, false);
    }
  }

  function sftpAssertDropUploadReady(state: SftpModalState): void {
    if (getActive() !== state || state.closing) {
      throw new Error('SFTP window was closed');
    }
    if (!state.sftpSessionId) {
      throw new Error('SFTP session is closed');
    }
  }

  async function sftpUploadDroppedItem(
    state: SftpModalState,
    localPath: string,
    remoteBaseDir: string,
    stats: SftpDroppedUploadStats,
  ): Promise<void> {
    const name = sftpBaseName(localPath).trim();
    if (!name) {
      stats.skipped += 1;
      return;
    }

    const dirList = await sftpTryListLocalDir(localPath);
    if (dirList) {
      const remoteDirPath = sftpRemoteJoinPath(remoteBaseDir, name);
      if (await sftpEnsureRemoteFolder(state, remoteDirPath)) {
        stats.foldersCreated += 1;
      }
      await sftpUploadDroppedDirectory(state, dirList, remoteDirPath, stats);
      return;
    }

    await sftpUploadDroppedFile(state, localPath, sftpRemoteJoinPath(remoteBaseDir, name), stats);
  }

  async function sftpTryListLocalDir(path: string): Promise<FileListResult | null> {
    try {
      return await deps.api.localFsList(path);
    } catch {
      return null;
    }
  }

  async function sftpUploadDroppedDirectory(
    state: SftpModalState,
    listing: FileListResult,
    remoteDirPath: string,
    stats: SftpDroppedUploadStats,
  ): Promise<void> {
    for (const entry of listing.entries) {
      sftpAssertDropUploadReady(state);
      const remotePath = sftpRemoteJoinPath(remoteDirPath, entry.name);

      if (entry.kind === 'dir') {
        try {
          if (await sftpEnsureRemoteFolder(state, remotePath)) {
            stats.foldersCreated += 1;
          }
          const childListing = await deps.api.localFsList(entry.path);
          await sftpUploadDroppedDirectory(state, childListing, remotePath, stats);
        } catch (error) {
          stats.errors += 1;
          if (sftpIsSessionClosedError(error)) {
            throw error;
          }
        }
        continue;
      }

      if (entry.kind === 'file') {
        await sftpUploadDroppedFile(state, entry.path, remotePath, stats);
        continue;
      }

      stats.skipped += 1;
    }
  }

  async function sftpUploadDroppedFile(
    state: SftpModalState,
    localPath: string,
    remotePath: string,
    stats: SftpDroppedUploadStats,
  ): Promise<void> {
    try {
      const outcome = await sftpUploadFileToRemoteWithOverwritePrompt(state, localPath, remotePath);
      if (outcome === 'uploaded') {
        stats.filesUploaded += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (error) {
      stats.errors += 1;
      if (sftpIsSessionClosedError(error)) {
        throw error;
      }
    }
  }

  async function sftpUploadFileToRemoteWithOverwritePrompt(
    state: SftpModalState,
    localPath: string,
    remotePath: string,
  ): Promise<'uploaded' | 'skipped'> {
    sftpAssertDropUploadReady(state);

    const upload = async (overwrite: boolean): Promise<void> => {
      await deps.api.sftpUploadFile({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId!,
        localPath,
        remotePath,
        overwrite,
      });
    };

    try {
      await upload(false);
      return 'uploaded';
    } catch (error) {
      const message = deps.formatError(error);
      if (!sftpIsAlreadyExistsError(message)) {
        throw error;
      }

      const fileName = sftpBaseName(remotePath);
      const ok = window.confirm(`Overwrite existing remote file "${fileName}"?`);
      if (!ok) {
        return 'skipped';
      }

      await upload(true);
      return 'uploaded';
    }
  }

  async function sftpEnsureRemoteFolder(state: SftpModalState, path: string): Promise<boolean> {
    sftpAssertDropUploadReady(state);
    try {
      await deps.api.sftpNewFolder({
        sshSessionId: state.sshSessionId,
        sftpSessionId: state.sftpSessionId!,
        path,
      });
      return true;
    } catch (error) {
      const message = deps.formatError(error);
      if (sftpIsAlreadyExistsError(message)) {
        return false;
      }
      throw error;
    }
  }

  function sftpIsAlreadyExistsError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('already exists') || lower.includes('file exists');
  }

  function sftpIsSessionClosedError(error: unknown): boolean {
    return deps.formatError(error).toLowerCase().includes('sftp session is closed');
  }

  function sftpFormatDroppedUploadSummary(stats: SftpDroppedUploadStats): string {
    const parts = [
      `${stats.filesUploaded} file${stats.filesUploaded === 1 ? '' : 's'} uploaded`,
      `${stats.foldersCreated} folder${stats.foldersCreated === 1 ? '' : 's'} created`,
    ];

    if (stats.skipped > 0) {
      parts.push(`${stats.skipped} skipped`);
    }
    if (stats.errors > 0) {
      parts.push(`${stats.errors} error${stats.errors === 1 ? '' : 's'}`);
      return `Drop upload finished with issues (${parts.join(', ')})`;
    }

    return `Drop upload complete (${parts.join(', ')})`;
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
