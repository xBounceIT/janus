import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import type { FileEntry, FileListResult, SftpTransferProgressEvent } from '../types';
import type {
  FilePaneSide,
  SessionTab,
  SftpInlineEditState,
  SftpModalState,
  SftpPaneConfirmState,
  SftpPaneState,
  SftpTransferUiState,
} from './types';

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
    listenSftpTransferProgress: (
      sftpSessionId: string,
      fn: (event: SftpTransferProgressEvent) => void,
    ) => Promise<() => void>;
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
      sortKey: 'name',
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
      transferStripEl: null,
      transferBarEl: null,
      transferLabelEl: null,
      transferMetaEl: null,
      transferState: null,
      transferProgressUnlisten: null,
      dragDropUnlisten: null,
      remoteDropHover: false,
      localDropReject: false,
      dropTransferRunning: false,
      inlineEdit: null,
      inlineEditCommitPromise: null,
      paneConfirm: null,
    };

    deps.showModal(`SFTP - ${tab.title}`, (card) => {
      setActive(state);
      state.card = card;
      card.classList.add('sftp-modal');

      const layout = document.createElement('div');
      layout.className = 'sftp-layout';

      const transferStripEl = document.createElement('div');
      transferStripEl.className = 'sftp-transfer-strip';
      transferStripEl.hidden = true;

      const transferLabelEl = document.createElement('div');
      transferLabelEl.className = 'sftp-transfer-label';

      const transferMetaEl = document.createElement('div');
      transferMetaEl.className = 'sftp-transfer-meta';

      const transferTrackEl = document.createElement('div');
      transferTrackEl.className = 'sftp-transfer-track';

      const transferBarEl = document.createElement('div');
      transferBarEl.className = 'sftp-transfer-bar';
      transferTrackEl.appendChild(transferBarEl);
      transferStripEl.append(transferLabelEl, transferMetaEl, transferTrackEl);

      state.transferStripEl = transferStripEl;
      state.transferBarEl = transferBarEl;
      state.transferLabelEl = transferLabelEl;
      state.transferMetaEl = transferMetaEl;

      const footer = document.createElement('div');
      footer.className = 'sftp-footer';

      const footerLeft = document.createElement('div');
      footerLeft.className = 'sftp-footer-left';

      const statusEl = document.createElement('p');
      statusEl.className = 'sftp-status';
      state.statusEl = statusEl;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn btn-primary';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', deps.hideModal);

      footerLeft.append(transferStripEl, statusEl);
      footer.append(footerLeft, closeBtn);

      layout.append(
        buildSftpPaneUi(state, state.local, 'My PC'),
        buildSftpPaneUi(state, state.remote, state.connectionName),
      );

      card.append(layout, footer);

      void sftpAttachTransferProgressListener(state);
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
      sftpSetLocalDropReject(state, false);
      const transferProgressUnlisten = state.transferProgressUnlisten;
      state.transferProgressUnlisten = null;
      if (transferProgressUnlisten) {
        try {
          transferProgressUnlisten();
        } catch {
          // Ignore transfer listener teardown errors during modal close.
        }
      }
      const dragDropUnlisten = state.dragDropUnlisten;
      state.dragDropUnlisten = null;
      if (dragDropUnlisten) {
        try {
          dragDropUnlisten();
        } catch {
          // Ignore teardown errors during modal close.
        }
      }
      sftpResolvePaneConfirm(state, false);
      state.inlineEdit = null;
      state.inlineEditCommitPromise = null;
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
      void sftpRunAfterInlineEditSettles(state, pane.side, () => sftpNavigateParent(state, pane.side));
    });

    const headerActions = document.createElement('div');
    headerActions.className = 'sftp-pane-header-actions';

    const sortToggle = document.createElement('div');
    sortToggle.className = 'sftp-pane-sort-toggle';
    sortToggle.setAttribute('role', 'group');
    sortToggle.setAttribute('aria-label', `${title} sort order`);

    const sortNameBtn = document.createElement('button');
    sortNameBtn.type = 'button';
    sortNameBtn.className = 'sftp-pane-sort-btn';
    sortNameBtn.textContent = 'Name';
    sortNameBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpSetActivePane(state, pane.side);
      pane.sortKey = 'name';
      sftpRenderPane(state, pane);
      updateSortButtons();
    });

    const sortSizeBtn = document.createElement('button');
    sortSizeBtn.type = 'button';
    sortSizeBtn.className = 'sftp-pane-sort-btn';
    sortSizeBtn.textContent = 'Size';
    sortSizeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpSetActivePane(state, pane.side);
      pane.sortKey = 'size';
      sftpRenderPane(state, pane);
      updateSortButtons();
    });

    const updateSortButtons = (): void => {
      sortNameBtn.classList.toggle('active', pane.sortKey === 'name');
      sortSizeBtn.classList.toggle('active', pane.sortKey === 'size');
      sortNameBtn.setAttribute('aria-pressed', String(pane.sortKey === 'name'));
      sortSizeBtn.setAttribute('aria-pressed', String(pane.sortKey === 'size'));
    };
    updateSortButtons();

    sortToggle.append(sortNameBtn, sortSizeBtn);
    headerActions.append(sortToggle, upBtn);
    header.append(titleEl, headerActions);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'sftp-pane-actions';

    const actions: Array<{ label: string; icon: string; onClick: () => void | Promise<void> }> = [
      { label: 'New File', icon: deps.sftpToolbarSvg('file-plus'), onClick: () => sftpCreateItem(state, pane.side, 'file') },
      {
        label: 'New Folder',
        icon: deps.sftpToolbarSvg('folder-plus'),
        onClick: () => sftpCreateItem(state, pane.side, 'folder'),
      },
      { label: 'Rename', icon: deps.sftpToolbarSvg('rename'), onClick: () => sftpRenameSelected(state, pane.side) },
      { label: 'Delete', icon: deps.sftpToolbarSvg('delete'), onClick: () => sftpDeleteSelected(state, pane.side) },
      pane.side === 'local'
        ? { label: 'Upload', icon: deps.sftpToolbarSvg('upload'), onClick: () => sftpTransfer(state, 'upload') }
        : { label: 'Download', icon: deps.sftpToolbarSvg('download'), onClick: () => sftpTransfer(state, 'download') },
      { label: 'Refresh', icon: deps.sftpToolbarSvg('refresh'), onClick: () => sftpRefreshPane(state, pane.side) },
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
        void sftpRunAfterInlineEditSettles(state, pane.side, action.onClick);
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
      void sftpRunAfterInlineEditSettles(state, pane.side, () => sftpLoadPane(state, pane.side, nextPath));
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
        const nextPath = pathEl.value.trim();
        if (!nextPath) return;
        void sftpRunAfterInlineEditSettles(state, pane.side, () => sftpLoadPane(state, pane.side, nextPath));
      } else if (event.key === 'Escape') {
        pathEl.readOnly = true;
        pathEl.value = pane.cwd;
        pathEl.blur();
      }
    });

    pathRow.append(pathEl, goBtn);

    const listEl = document.createElement('div');
    listEl.className = 'sftp-file-list';

    const dropOverlayEl = document.createElement('div');
    dropOverlayEl.className = 'sftp-pane-drop-overlay';
    dropOverlayEl.setAttribute('aria-hidden', 'true');

    const overlayInner = document.createElement('div');
    overlayInner.className = 'sftp-pane-drop-overlay-inner';

    if (pane.side === 'remote') {
      const plus = document.createElement('div');
      plus.className = 'sftp-pane-drop-plus';
      plus.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';

      const subtitle = document.createElement('div');
      subtitle.className = 'sftp-pane-drop-subtitle';
      subtitle.textContent = 'Drop files or folders here to upload';

      overlayInner.append(plus, subtitle);
    } else {
      const x = document.createElement('div');
      x.className = 'sftp-pane-drop-x';
      x.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

      const subtitle = document.createElement('div');
      subtitle.className = 'sftp-pane-drop-subtitle';
      subtitle.textContent = 'Drop on remote pane to upload';

      overlayInner.append(x, subtitle);
    }

    dropOverlayEl.appendChild(overlayInner);
    root.append(header, actionsRow, pathRow, listEl, dropOverlayEl);

    root.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = pane.side === 'remote' ? 'copy' : 'none';
      }
    });
    root.addEventListener('drop', (event) => {
      event.preventDefault();
    });

    pane.rootEl = root;
    pane.pathEl = pathEl;
    pane.listEl = listEl;
    pane.dropOverlayEl = dropOverlayEl;

    sftpSetActivePane(state, state.activePane);
    if (pane.side === 'remote') {
      sftpSetRemoteDropHover(state, state.remoteDropHover);
    } else {
      sftpSetLocalDropReject(state, state.localDropReject);
    }
    sftpRenderPane(state, pane);

    return root;
  }

  function sftpSetStatus(state: SftpModalState, message: string, kind: 'info' | 'error' = 'info'): void {
    if (getActive() !== state || !state.statusEl) return;
    state.statusEl.textContent = message;
    state.statusEl.classList.toggle('error', kind === 'error');
  }

  function sftpRenderAllPanes(state: SftpModalState): void {
    sftpRenderPane(state, state.local);
    sftpRenderPane(state, state.remote);
  }

  function sftpResolvePaneConfirm(state: SftpModalState, confirmed: boolean): void {
    const paneConfirm = state.paneConfirm;
    if (!paneConfirm) return;
    state.paneConfirm = null;
    const resolver = paneConfirm.resolver;
    paneConfirm.resolver = null;
    if (resolver) {
      resolver(confirmed);
    }
    sftpRenderAllPanes(state);
  }

  function sftpAskPaneConfirm(
    state: SftpModalState,
    side: FilePaneSide,
    options: Pick<SftpPaneConfirmState, 'message' | 'confirmLabel' | 'tone'>,
  ): Promise<boolean> {
    if (state.paneConfirm) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      state.paneConfirm = {
        side,
        message: options.message,
        confirmLabel: options.confirmLabel,
        tone: options.tone,
        resolver: resolve,
      };
      sftpRenderAllPanes(state);
    });
  }

  function sftpGetInlineEditForPane(state: SftpModalState, pane: SftpPaneState): SftpInlineEditState | null {
    return state.inlineEdit && state.inlineEdit.side === pane.side ? state.inlineEdit : null;
  }

  function sftpBeginInlineEdit(state: SftpModalState, next: SftpInlineEditState): void {
    if (state.inlineEdit?.submitting) return;
    if (state.inlineEdit) {
      sftpSetStatus(state, 'Finish or cancel the current rename/create first', 'error');
      sftpSetActivePane(state, state.inlineEdit.side);
      sftpRenderAllPanes(state);
      return;
    }
    if (state.paneConfirm) {
      sftpResolvePaneConfirm(state, false);
    }
    state.inlineEdit = next;
    sftpSetActivePane(state, next.side);
    sftpRenderAllPanes(state);
  }

  function sftpValidateEntryName(state: SftpModalState, name: string): boolean {
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      sftpSetStatus(state, 'Name cannot contain path separators', 'error');
      return false;
    }
    return true;
  }

  function sftpSelectRenameInputText(input: HTMLInputElement, name: string, kind: FileEntry['kind'] | null): void {
    if (kind !== 'file') {
      input.select();
      return;
    }
    const lastDot = name.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === name.length - 1) {
      input.select();
      return;
    }
    input.setSelectionRange(0, lastDot);
  }

  function sftpFocusInlineEditInput(
    state: SftpModalState,
    edit: SftpInlineEditState,
    input: HTMLInputElement,
    kind: FileEntry['kind'] | null,
  ): void {
    queueMicrotask(() => {
      if (getActive() !== state || state.closing) return;
      if (state.inlineEdit !== edit) return;
      if (!input.isConnected) return;
      input.focus();
      if (edit.mode === 'rename') {
        sftpSelectRenameInputText(input, input.value, kind);
      } else {
        input.select();
      }
    });
  }

  function sftpStartInlineEditCommit(
    state: SftpModalState,
    edit: SftpInlineEditState,
    trigger: 'enter' | 'blur',
  ): Promise<void> {
    if (state.inlineEdit !== edit) {
      return Promise.resolve();
    }
    if (edit.submitting && state.inlineEditCommitPromise) {
      return state.inlineEditCommitPromise;
    }

    const commitPromise = sftpCommitInlineEdit(state, edit, trigger);
    state.inlineEditCommitPromise = commitPromise;
    void commitPromise.finally(() => {
      if (state.inlineEditCommitPromise === commitPromise) {
        state.inlineEditCommitPromise = null;
      }
    });
    return commitPromise;
  }

  async function sftpAwaitInlineEditBeforePaneAction(state: SftpModalState, side: FilePaneSide): Promise<boolean> {
    const editBefore = state.inlineEdit;
    const pendingCommit = state.inlineEditCommitPromise;
    if (pendingCommit) {
      await pendingCommit;
      if (getActive() !== state || state.closing) return false;
      if (editBefore && state.inlineEdit === editBefore) return false;
      return true;
    }

    if (!editBefore || editBefore.side !== side) {
      return getActive() === state && !state.closing;
    }

    await sftpStartInlineEditCommit(state, editBefore, 'blur');
    if (getActive() !== state || state.closing) return false;
    if (state.inlineEdit === editBefore) return false;
    return true;
  }

  async function sftpAwaitInlineEditBeforeGlobalAction(state: SftpModalState): Promise<boolean> {
    const editBefore = state.inlineEdit;
    const pendingCommit = state.inlineEditCommitPromise;
    if (pendingCommit) {
      await pendingCommit;
      if (getActive() !== state || state.closing) return false;
      if (editBefore && state.inlineEdit === editBefore) {
        sftpSetStatus(state, 'Finish or cancel the current rename/create first', 'error');
        sftpSetActivePane(state, editBefore.side);
        return false;
      }
    }

    if (getActive() !== state || state.closing) return false;

    const activeEdit = state.inlineEdit;
    if (!activeEdit) {
      return true;
    }

    sftpSetStatus(state, 'Finish or cancel the current rename/create first', 'error');
    sftpSetActivePane(state, activeEdit.side);
    return false;
  }

  async function sftpRunAfterInlineEditSettles(
    state: SftpModalState,
    side: FilePaneSide,
    action: () => void | Promise<void>,
  ): Promise<void> {
    if (!(await sftpAwaitInlineEditBeforePaneAction(state, side))) return;
    await action();
  }

  async function sftpCommitInlineEdit(
    state: SftpModalState,
    edit: SftpInlineEditState,
    _trigger: 'enter' | 'blur',
  ): Promise<void> {
    if (state.inlineEdit !== edit || edit.submitting) return;

    const pane = sftpGetPane(state, edit.side);
    const trimmed = edit.draftName.trim();

    if (edit.mode === 'create') {
      if (!trimmed) {
        state.inlineEdit = null;
        sftpRenderAllPanes(state);
        return;
      }
      if (!pane.cwd) {
        sftpSetStatus(state, 'Target folder is unavailable', 'error');
        return;
      }
      if (!sftpValidateEntryName(state, trimmed)) {
        sftpRenderPane(state, pane);
        return;
      }

      const kind = edit.createKind === 'folder' ? 'folder' : 'file';
      const fullPath = pane.side === 'local' ? sftpLocalJoinPath(pane.cwd, trimmed) : sftpRemoteJoinPath(pane.cwd, trimmed);

      edit.submitting = true;
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
        if (state.inlineEdit === edit) {
          state.inlineEdit = null;
        }
        sftpSetStatus(state, `${kind === 'file' ? 'File' : 'Folder'} created`);
        sftpRenderAllPanes(state);
        await sftpLoadPane(state, pane.side, pane.cwd);
      } catch (error) {
        if (state.inlineEdit === edit) {
          edit.submitting = false;
        }
        sftpSetStatus(state, deps.formatError(error), 'error');
        sftpRenderPane(state, pane);
      }
      return;
    }

    const originalName = edit.originalName ?? '';
    if (!trimmed || trimmed === originalName) {
      if (state.inlineEdit === edit) {
        state.inlineEdit = null;
        sftpRenderAllPanes(state);
      }
      return;
    }
    if (!sftpValidateEntryName(state, trimmed)) {
      sftpRenderPane(state, pane);
      return;
    }

    const targetPath = edit.targetPath;
    if (!targetPath) {
      state.inlineEdit = null;
      sftpRenderAllPanes(state);
      return;
    }

    const parent = pane.side === 'local' ? sftpLocalParentPath(targetPath) : sftpRemoteParentPath(targetPath);
    const newPath =
      pane.side === 'local' ? sftpLocalJoinPath(parent ?? pane.cwd, trimmed) : sftpRemoteJoinPath(parent ?? pane.cwd, trimmed);

    edit.submitting = true;
    try {
      if (pane.side === 'local') {
        await deps.api.localFsRename(targetPath, newPath);
      } else {
        if (!state.sftpSessionId) throw new Error('SFTP session is closed');
        await deps.api.sftpRename({
          sshSessionId: state.sshSessionId,
          sftpSessionId: state.sftpSessionId,
          oldPath: targetPath,
          newPath,
        });
      }
      if (state.inlineEdit === edit) {
        state.inlineEdit = null;
      }
      sftpSetStatus(state, 'Renamed');
      sftpRenderAllPanes(state);
      await sftpLoadPane(state, pane.side, pane.cwd);
    } catch (error) {
      if (state.inlineEdit === edit) {
        edit.submitting = false;
      }
      sftpSetStatus(state, deps.formatError(error), 'error');
      sftpRenderPane(state, pane);
    }
  }

  function sftpCancelInlineEdit(state: SftpModalState, edit: SftpInlineEditState): void {
    if (state.inlineEdit !== edit) return;
    state.inlineEdit = null;
    sftpRenderAllPanes(state);
  }

  async function sftpAttachTransferProgressListener(state: SftpModalState): Promise<void> {
    if (!state.sftpSessionId) return;
    try {
      const unlisten = await deps.api.listenSftpTransferProgress(state.sftpSessionId, (event) => {
        sftpHandleTransferProgressEvent(state, event);
      });

      if (getActive() !== state || state.closing || state.sftpSessionId == null) {
        unlisten();
        return;
      }

      if (state.transferProgressUnlisten) {
        unlisten();
        return;
      }

      state.transferProgressUnlisten = unlisten;
    } catch (error) {
      sftpSetStatus(state, `Transfer progress is unavailable: ${deps.formatError(error)}`, 'error');
    }
  }

  function sftpHandleTransferProgressEvent(state: SftpModalState, event: SftpTransferProgressEvent): void {
    if (getActive() !== state || state.closing) return;
    const transfer = state.transferState;
    if (!transfer || transfer.direction !== event.direction) return;

    const fileKey = `${event.localPath}::${event.remotePath}`;

    if (transfer.mode === 'batch-upload') {
      if (event.phase === 'start' || transfer.currentFileKey !== fileKey) {
        transfer.currentFileKey = fileKey;
        transfer.currentFileBytes = 0;
        transfer.currentFileTotalBytes = null;
      }
      if (event.totalBytes != null) {
        const known = transfer.fileTotals.get(fileKey);
        if (known == null) {
          transfer.fileTotals.set(fileKey, event.totalBytes);
          transfer.totalBytes = (transfer.totalBytes ?? 0) + event.totalBytes;
        }
        transfer.currentFileTotalBytes = event.totalBytes;
      } else if (transfer.currentFileTotalBytes == null) {
        transfer.currentFileTotalBytes = transfer.fileTotals.get(fileKey) ?? null;
      }

      if (event.phase === 'start') {
        transfer.currentFileBytes = 0;
      } else {
        transfer.currentFileBytes = event.bytesTransferred;
      }

      if (event.phase === 'complete' && !transfer.fileCompleted.has(fileKey)) {
        transfer.fileCompleted.add(fileKey);
        transfer.completedBytesBase += transfer.currentFileTotalBytes ?? event.bytesTransferred;
        transfer.currentFileBytes = 0;
        transfer.currentFileTotalBytes = null;
      }
    } else {
      transfer.currentFileKey = fileKey;
      if (event.phase === 'start') {
        transfer.currentFileBytes = 0;
      } else {
        transfer.currentFileBytes = event.bytesTransferred;
      }
      if (event.totalBytes != null) {
        transfer.currentFileTotalBytes = event.totalBytes;
        transfer.totalBytes = event.totalBytes;
      }
    }

    sftpUpdateTransferUiState(transfer);
    sftpRenderTransferProgress(state);
  }

  function sftpBeginTrackedTransfer(
    state: SftpModalState,
    options:
      | { mode: 'single'; direction: 'upload' | 'download'; label: string; totalBytes: number | null }
      | { mode: 'batch-upload'; label: string; totalBytes: number | null },
  ): SftpTransferUiState | null {
    if (state.transferState) {
      return null;
    }

    const now = Date.now();
    const transferState: SftpTransferUiState = {
      mode: options.mode,
      direction: options.mode === 'single' ? options.direction : 'upload',
      label: options.mode === 'single' ? options.label : options.label,
      totalBytes: options.mode === 'single' ? options.totalBytes : options.totalBytes,
      completedBytesBase: 0,
      currentFileBytes: 0,
      currentFileTotalBytes: null,
      startedAtMs: now,
      lastSampleAtMs: now,
      lastSampleTotalBytes: 0,
      speedBytesPerSec: 0,
      percent: 0,
      currentFileKey: null,
      fileTotals: new Map<string, number>(),
      fileCompleted: new Set<string>(),
    };

    state.transferState = transferState;
    sftpRenderTransferProgress(state);
    return transferState;
  }

  function sftpEndTrackedTransfer(state: SftpModalState, transfer: SftpTransferUiState | null): void {
    if (!transfer) return;
    if (state.transferState !== transfer) return;
    state.transferState = null;
    sftpRenderTransferProgress(state);
  }

  function sftpUpdateTransferUiState(transfer: SftpTransferUiState): void {
    const now = Date.now();
    const totalDone = transfer.completedBytesBase + transfer.currentFileBytes;
    const sampleDeltaMs = now - transfer.lastSampleAtMs;
    if (sampleDeltaMs >= 200) {
      const sampleDeltaBytes = totalDone - transfer.lastSampleTotalBytes;
      if (sampleDeltaBytes >= 0) {
        transfer.speedBytesPerSec = sampleDeltaBytes / (sampleDeltaMs / 1000);
      }
      transfer.lastSampleAtMs = now;
      transfer.lastSampleTotalBytes = totalDone;
    }

    if (transfer.totalBytes != null && transfer.totalBytes > 0) {
      transfer.percent = Math.max(0, Math.min(100, (totalDone / transfer.totalBytes) * 100));
    } else {
      transfer.percent = 0;
    }
  }

  function sftpRenderTransferProgress(state: SftpModalState): void {
    const strip = state.transferStripEl;
    const bar = state.transferBarEl;
    const labelEl = state.transferLabelEl;
    const metaEl = state.transferMetaEl;
    if (!strip || !bar || !labelEl || !metaEl) return;

    const transfer = state.transferState;
    if (!transfer) {
      strip.hidden = true;
      bar.style.width = '0%';
      labelEl.textContent = '';
      metaEl.textContent = '';
      return;
    }

    strip.hidden = false;
    const totalDone = transfer.completedBytesBase + transfer.currentFileBytes;
    const percentText =
      transfer.totalBytes != null && transfer.totalBytes > 0 ? `${Math.round(transfer.percent)}%` : '--%';
    const totalText = transfer.totalBytes != null ? sftpFormatBytes(transfer.totalBytes) : '?';

    labelEl.textContent = transfer.label;
    metaEl.textContent = `${percentText} • ${sftpFormatSpeed(transfer.speedBytesPerSec)} • ${sftpFormatBytes(totalDone)} / ${totalText}`;
    bar.style.width = `${transfer.totalBytes && transfer.totalBytes > 0 ? transfer.percent : 0}%`;
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

  function sftpSetLocalDropReject(state: SftpModalState, hovering: boolean): void {
    state.localDropReject = hovering;
    state.local.rootEl?.classList.toggle('drop-reject', hovering);
  }

  function sftpSelectPaneEntry(state: SftpModalState, side: FilePaneSide, entry: FileEntry | null): void {
    const pane = sftpGetPane(state, side);
    sftpSetActivePane(state, side);
    pane.selectedPath = entry?.path ?? null;
    pane.selectedKind = entry?.kind ?? null;
    sftpRenderPane(state, pane);
  }

  function sftpCreatePaneColumnHeader(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'sftp-file-header-row';
    sftpAppendRowCell(row, 'sftp-file-icon', '');
    sftpAppendRowCell(row, 'sftp-file-name', 'Name');
    sftpAppendRowCell(row, 'sftp-file-owner', 'Owner');
    sftpAppendRowCell(row, 'sftp-file-perms', 'Permissions');
    sftpAppendRowCell(row, 'sftp-file-size', 'Size');
    return row;
  }

  function sftpCreateParentRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sftp-file-row parent';
    const icon = document.createElement('span');
    icon.className = 'sftp-file-icon';
    icon.innerHTML = deps.sftpEntryIcon('dir');
    row.appendChild(icon);
    sftpAppendRowCell(row, 'sftp-file-name', '..');
    sftpAppendRowCell(row, 'sftp-file-owner', '-');
    sftpAppendRowCell(row, 'sftp-file-perms', '-');
    sftpAppendRowCell(row, 'sftp-file-size', '-');
    return row;
  }

  function sftpCreateEntryRow(entry: FileEntry, selected: boolean): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `sftp-file-row${selected ? ' selected' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'sftp-file-icon';
    icon.innerHTML = deps.sftpEntryIcon(entry.kind);
    row.appendChild(icon);

    sftpAppendRowCell(row, 'sftp-file-name', entry.name);
    sftpAppendRowCell(row, 'sftp-file-owner', sftpFormatOwner(entry.owner));

    const perms = sftpFormatPermissions(entry.permissions);
    const permsCell = sftpAppendRowCell(row, 'sftp-file-perms', perms);
    const octal = sftpFormatPermissionsOctal(entry.permissions);
    if (octal) {
      permsCell.title = octal;
    }

    const sizeText = entry.kind === 'dir' ? '-' : sftpFormatFileSize(entry.size);
    sftpAppendRowCell(row, 'sftp-file-size', sizeText);
    return row;
  }

  function sftpCreateInlineEditRow(
    state: SftpModalState,
    pane: SftpPaneState,
    edit: SftpInlineEditState,
    entry: FileEntry | null,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = `sftp-file-row sftp-file-row-inline${edit.mode === 'rename' ? ' selected' : ''}`;
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpSetActivePane(state, pane.side);
    });

    const icon = document.createElement('span');
    icon.className = 'sftp-file-icon';
    const iconKind =
      edit.mode === 'create'
        ? edit.createKind === 'folder'
          ? 'dir'
          : 'file'
        : edit.targetKind ?? entry?.kind ?? 'file';
    icon.innerHTML = deps.sftpEntryIcon(iconKind);
    row.appendChild(icon);

    const nameCell = document.createElement('span');
    nameCell.className = 'sftp-file-name sftp-file-name-inline';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sftp-inline-name-input';
    input.value = edit.draftName;
    input.disabled = edit.submitting;
    input.setAttribute('aria-label', edit.mode === 'create' ? 'New item name' : 'Rename item');
    nameCell.appendChild(input);
    row.appendChild(nameCell);

    const ownerText = entry ? sftpFormatOwner(entry.owner) : '-';
    sftpAppendRowCell(row, 'sftp-file-owner', ownerText);

    const perms = entry ? sftpFormatPermissions(entry.permissions) : '-';
    const permsCell = sftpAppendRowCell(row, 'sftp-file-perms', perms);
    if (entry) {
      const octal = sftpFormatPermissionsOctal(entry.permissions);
      if (octal) {
        permsCell.title = octal;
      }
    }

    const sizeText = entry ? (entry.kind === 'dir' ? '-' : sftpFormatFileSize(entry.size)) : '-';
    sftpAppendRowCell(row, 'sftp-file-size', sizeText);

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    input.addEventListener('input', () => {
      if (state.inlineEdit !== edit) return;
      edit.draftName = input.value;
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void sftpStartInlineEditCommit(state, edit, 'enter');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        sftpCancelInlineEdit(state, edit);
      }
    });
    input.addEventListener('blur', () => {
      void sftpStartInlineEditCommit(state, edit, 'blur');
    });

    if (!edit.submitting) {
      sftpFocusInlineEditInput(state, edit, input, iconKind);
    }

    return row;
  }

  function sftpAppendRowCell<T extends HTMLElement>(row: T, className: string, text: string): HTMLSpanElement {
    const cell = document.createElement('span');
    cell.className = className;
    cell.textContent = text;
    row.appendChild(cell);
    return cell;
  }

  function sftpRenderPaneConfirmOverlay(state: SftpModalState, pane: SftpPaneState): void {
    const root = pane.rootEl;
    if (!root) return;
    root.querySelector('.sftp-pane-confirm-overlay')?.remove();

    const paneConfirm = state.paneConfirm;
    if (!paneConfirm || paneConfirm.side !== pane.side) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'sftp-pane-confirm-overlay';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Confirmation');
    overlay.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target === overlay) {
        sftpResolvePaneConfirm(state, false);
      }
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        sftpResolvePaneConfirm(state, false);
      }
    });

    const card = document.createElement('div');
    card.className = 'sftp-pane-confirm-card';
    card.addEventListener('click', (event) => event.stopPropagation());

    const message = document.createElement('p');
    message.className = 'sftp-pane-confirm-message';
    message.textContent = paneConfirm.message;

    const actions = document.createElement('div');
    actions.className = 'sftp-pane-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpResolvePaneConfirm(state, false);
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `btn btn-sm${paneConfirm.tone === 'danger' ? ' btn-danger' : ' btn-primary'}`;
    confirmBtn.textContent = paneConfirm.confirmLabel;
    confirmBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      sftpResolvePaneConfirm(state, true);
    });

    actions.append(cancelBtn, confirmBtn);
    card.append(message, actions);
    overlay.appendChild(card);
    root.appendChild(overlay);

    queueMicrotask(() => {
      if (getActive() !== state || state.closing) return;
      if (state.paneConfirm !== paneConfirm) return;
      if (!overlay.isConnected) return;
      overlay.focus();
    });
  }

  function sftpSortEntriesForPane(entries: FileEntry[], sortKey: 'name' | 'size'): FileEntry[] {
    const sorted = [...entries];
    sorted.sort((a, b) => {
      const aDir = a.kind === 'dir';
      const bDir = b.kind === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;

      if (sortKey === 'size' && !aDir && !bDir) {
        const aSize = a.size ?? Number.NEGATIVE_INFINITY;
        const bSize = b.size ?? Number.NEGATIVE_INFINITY;
        if (aSize !== bSize) return bSize - aSize;
      }

      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    return sorted;
  }

  function sftpFormatOwner(owner: string | null | undefined): string {
    const trimmed = owner?.trim();
    return trimmed ? trimmed : '-';
  }

  function sftpFormatPermissions(mode: number | null | undefined): string {
    if (mode == null) return '-';
    const bits = mode & 0o777;
    const triplets = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1];
    return triplets.map((flag, idx) => ((bits & flag) !== 0 ? 'rwx'[idx % 3] : '-')).join('');
  }

  function sftpFormatPermissionsOctal(mode: number | null | undefined): string | null {
    if (mode == null) return null;
    const bits = mode & 0o7777;
    return `0${bits.toString(8)}`;
  }

  function sftpFormatFileSize(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return '-';
    return sftpFormatBytes(bytes);
  }

  function sftpFormatBytes(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '-';
    if (value < 1000) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let scaled = value;
    let unit = 'B';
    for (const next of units) {
      scaled /= 1000;
      unit = next;
      if (scaled < 1000) break;
    }
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(digits)} ${unit}`;
  }

  function sftpFormatSpeed(bytesPerSec: number): string {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 MB/s';
    return `${sftpFormatBytes(bytesPerSec)}/s`;
  }

  function sftpRenderPane(state: SftpModalState, pane: SftpPaneState): void {
    if (!pane.listEl) return;
    let paneInlineEdit = sftpGetInlineEditForPane(state, pane);
    if (paneInlineEdit?.mode === 'rename') {
      const hasTarget = paneInlineEdit.targetPath
        ? pane.entries.some((entry) => entry.path === paneInlineEdit?.targetPath)
        : false;
      if (!hasTarget) {
        if (state.inlineEdit === paneInlineEdit) {
          state.inlineEdit = null;
        }
        paneInlineEdit = null;
      }
    }
    const paneConfirm = state.paneConfirm?.side === pane.side ? state.paneConfirm : null;
    if (pane.side === 'remote') {
      pane.rootEl?.classList.toggle('drop-hover', state.remoteDropHover);
    }
    pane.rootEl?.classList.toggle('has-confirm', Boolean(paneConfirm));

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

    frag.appendChild(sftpCreatePaneColumnHeader());

    const parentPath = pane.side === 'remote' ? sftpRemoteParentPath(pane.cwd) : sftpLocalParentPath(pane.cwd);
    if (parentPath) {
      const parentRow = sftpCreateParentRow();
      parentRow.addEventListener('click', () => {
        sftpSetActivePane(state, pane.side);
      });
      parentRow.addEventListener('dblclick', () => {
        void sftpRunAfterInlineEditSettles(state, pane.side, () => sftpLoadPane(state, pane.side, parentPath));
      });
      frag.appendChild(parentRow);
    }

    if (paneInlineEdit?.mode === 'create') {
      frag.appendChild(sftpCreateInlineEditRow(state, pane, paneInlineEdit, null));
    }

    const sortedEntries = sftpSortEntriesForPane(pane.entries, pane.sortKey);
    if (sortedEntries.length === 0) {
      if (paneInlineEdit?.mode !== 'create') {
        const empty = document.createElement('div');
        empty.className = 'sftp-file-row sftp-file-row-empty';
        empty.textContent = 'Empty';
        frag.appendChild(empty);
      }
    } else {
      for (const entry of sortedEntries) {
        if (paneInlineEdit?.mode === 'rename' && paneInlineEdit.targetPath === entry.path) {
          frag.appendChild(sftpCreateInlineEditRow(state, pane, paneInlineEdit, entry));
          continue;
        }
        const row = sftpCreateEntryRow(entry, pane.selectedPath === entry.path);
        row.addEventListener('click', () => sftpSelectPaneEntry(state, pane.side, entry));
        row.addEventListener('dblclick', () => {
          sftpSelectPaneEntry(state, pane.side, entry);
          if (entry.kind === 'dir') {
            void sftpRunAfterInlineEditSettles(state, pane.side, () => sftpLoadPane(state, pane.side, entry.path));
          }
        });

        frag.appendChild(row);
      }
    }

    pane.listEl.appendChild(frag);
    sftpRenderPaneConfirmOverlay(state, pane);
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
    sftpBeginInlineEdit(state, {
      side,
      mode: 'create',
      createKind: kind,
      targetPath: null,
      targetKind: kind === 'folder' ? 'dir' : 'file',
      originalName: null,
      draftName: '',
      submitting: false,
    });
  }

  async function sftpRenameSelected(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
    const entry = pane.entries.find((item) => item.path === pane.selectedPath);
    if (!entry) {
      sftpSetStatus(state, 'Select a file or folder to rename', 'error');
      return;
    }
    sftpBeginInlineEdit(state, {
      side,
      mode: 'rename',
      createKind: null,
      targetPath: entry.path,
      targetKind: entry.kind,
      originalName: entry.name,
      draftName: entry.name,
      submitting: false,
    });
  }

  async function sftpDeleteSelected(state: SftpModalState, side: FilePaneSide): Promise<void> {
    const pane = sftpGetPane(state, side);
    const entry = pane.entries.find((item) => item.path === pane.selectedPath);
    if (!entry) {
      sftpSetStatus(state, 'Select a file or folder to delete', 'error');
      return;
    }

    const confirmed = await sftpAskPaneConfirm(state, side, {
      message: `Delete ${entry.kind === 'dir' ? 'folder' : 'file'} "${entry.name}"?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
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
    if (!(await sftpAwaitInlineEditBeforeGlobalAction(state))) {
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
    const activeTransfer = sftpBeginTrackedTransfer(state, {
      mode: 'single',
      direction,
      label: `${direction === 'upload' ? 'Uploading' : 'Downloading'} ${fileName}`,
      totalBytes: sourceEntry.size ?? null,
    });
    if (!activeTransfer) {
      sftpSetStatus(state, 'Another transfer is already in progress', 'error');
      return;
    }

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
      try {
        await runTransfer(false);
      } catch (error) {
        const message = deps.formatError(error);
        if (message.toLowerCase().includes('already exists')) {
          const ok = await sftpAskPaneConfirm(state, direction === 'upload' ? 'remote' : 'local', {
            message: `Overwrite existing ${direction === 'upload' ? 'remote' : 'local'} file "${fileName}"?`,
            confirmLabel: 'Overwrite',
            tone: 'default',
          });
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
    } finally {
      sftpEndTrackedTransfer(state, activeTransfer);
    }
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
      sftpSetLocalDropReject(state, false);
      return;
    }

    const insideRemotePane = sftpPaneContainsPhysicalPoint(state, 'remote', payload.position);
    const insideLocalPane = sftpPaneContainsPhysicalPoint(state, 'local', payload.position);

    if (payload.type === 'enter' || payload.type === 'over') {
      const canHover = insideRemotePane && Boolean(state.remote.cwd) && !state.dropTransferRunning && !state.paneConfirm;
      sftpSetRemoteDropHover(state, canHover);
      sftpSetLocalDropReject(state, insideLocalPane);
      if (canHover) {
        sftpSetActivePane(state, 'remote');
      }
      return;
    }

    sftpSetRemoteDropHover(state, false);
    sftpSetLocalDropReject(state, false);
    if (!insideRemotePane) return;
    void sftpHandleRemoteDropPaths(state, payload.paths);
  }

  function sftpPaneContainsPhysicalPoint(
    state: SftpModalState,
    side: FilePaneSide,
    position: { x: number; y: number },
  ): boolean {
    const root = sftpGetPane(state, side).rootEl;
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
    if (state.paneConfirm) {
      sftpSetStatus(state, 'Finish the confirmation dialog first', 'error');
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

    const activeTransfer = sftpBeginTrackedTransfer(state, {
      mode: 'batch-upload',
      label: `Uploading ${paths.length} dropped item${paths.length === 1 ? '' : 's'}`,
      totalBytes: null,
    });
    if (!activeTransfer) {
      sftpSetStatus(state, 'Another transfer is already in progress', 'error');
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
      sftpEndTrackedTransfer(state, activeTransfer);
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
      const ok = await sftpAskPaneConfirm(state, 'remote', {
        message: `Overwrite existing remote file "${fileName}"?`,
        confirmLabel: 'Overwrite',
        tone: 'default',
      });
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
