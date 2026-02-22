import type { ConnectionNode, ConnectionUpsert, FolderUpsert, ImportRequest } from '../types';

type ApiClient = typeof import('../api').api;

export type CrudModalControllerDeps = {
  showModal: (title: string, buildContent: (card: HTMLDivElement) => void) => void;
  hideModal: () => void;
  wireModalEnterKey: (card: HTMLElement, confirmSelector: string) => void;
  escapeAttr: (input: string) => string;
  escapeHtml: (input: string) => string;
  upsertFolder: ApiClient['upsertFolder'];
  upsertConnection: ApiClient['upsertConnection'];
  deleteNode: ApiClient['deleteNode'];
  importMremote: ApiClient['importMremote'];
  exportMremote: ApiClient['exportMremote'];
  expandedFolders: Set<string | null>;
  refreshTree: () => Promise<void>;
  writeStatus: (message: string) => void;
  formatError: (error: unknown) => string;
};

export type CrudModalController = {
  showFolderModal: (parentId: string | null) => void;
  showRenameModal: (node: ConnectionNode) => void;
  showDeleteModal: (node: ConnectionNode) => void;
  showImportModal: () => void;
  showExportModal: () => void;
};

export function createCrudModalController(deps: CrudModalControllerDeps): CrudModalController {
  function showFolderModal(parentId: string | null): void {
    deps.showModal('New Folder', (card) => {
      card.innerHTML += `
        <div class="form-field">
          <label>Name</label>
          <input id="modal-folder-name" type="text" placeholder="Folder name" />
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-confirm">Create</button>
        </div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);
      card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
        const name = (card.querySelector('#modal-folder-name') as HTMLInputElement).value.trim();
        if (!name) return;

        const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Creating...';

        try {
          const folder: FolderUpsert = {
            id: crypto.randomUUID(),
            parentId,
            name,
            orderIndex: Date.now(),
          };
          await deps.upsertFolder(folder);
          if (parentId) deps.expandedFolders.add(parentId);
          deps.hideModal();
          await deps.refreshTree();
          deps.writeStatus('Folder created');
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          btn.disabled = false;
          btn.textContent = 'Create';
        }
      });

      deps.wireModalEnterKey(card, '#modal-confirm');
    });
  }

  function showRenameModal(node: ConnectionNode): void {
    deps.showModal('Rename', (card) => {
      card.innerHTML += `
        <div class="form-field">
          <label>Name</label>
          <input id="modal-rename" type="text" value="${deps.escapeAttr(node.name)}" />
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-confirm">Rename</button>
        </div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);
      card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
        const name = (card.querySelector('#modal-rename') as HTMLInputElement).value.trim();
        if (!name) return;

        const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Renaming...';

        try {
          if (node.kind === 'folder') {
            const folder: FolderUpsert = {
              id: node.id,
              parentId: node.parentId,
              name,
              orderIndex: node.orderIndex,
            };
            await deps.upsertFolder(folder);
          } else {
            const payload: ConnectionUpsert = {
              id: node.id,
              parentId: node.parentId,
              kind: node.kind as 'ssh' | 'rdp',
              name,
              orderIndex: node.orderIndex,
            };

            if (node.kind === 'ssh' && node.ssh) {
              payload.ssh = {
                host: node.ssh.host,
                port: node.ssh.port,
                username: node.ssh.username,
                strictHostKey: node.ssh.strictHostKey,
                keyPath: node.ssh.keyPath ?? null,
              };
            } else if (node.kind === 'rdp' && node.rdp) {
              payload.rdp = {
                host: node.rdp.host,
                port: node.rdp.port,
                username: node.rdp.username ?? null,
                domain: node.rdp.domain ?? null,
                screenMode: node.rdp.screenMode,
                width: node.rdp.width ?? null,
                height: node.rdp.height ?? null,
              };
            }

            await deps.upsertConnection(payload);
          }

          deps.hideModal();
          await deps.refreshTree();
          deps.writeStatus('Renamed');
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          btn.disabled = false;
          btn.textContent = 'Rename';
        }
      });

      deps.wireModalEnterKey(card, '#modal-confirm');
    });
  }

  function showDeleteModal(node: ConnectionNode): void {
    deps.showModal('Delete', (card) => {
      const p = document.createElement('p');
      p.style.color = 'var(--text-dim)';
      p.style.fontSize = '0.875rem';
      p.style.marginBottom = '0.75rem';
      p.textContent = `Are you sure you want to delete "${node.name}"?`;
      if (node.kind === 'folder') {
        p.textContent += ' This will also delete all children.';
      }
      card.appendChild(p);

      card.innerHTML += `
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn btn-danger" id="modal-confirm">Delete</button>
        </div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);
      card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
        const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Deleting...';

        try {
          await deps.deleteNode(node.id);
          deps.hideModal();
          await deps.refreshTree();
          deps.writeStatus('Deleted');
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      });
    });
  }

  function renderImportReport(card: HTMLDivElement, prefix: string, report: Awaited<ReturnType<ApiClient['importMremote']>>): void {
    const reportEl = card.querySelector('#modal-import-report');
    if (!reportEl) return;
    reportEl.innerHTML = `<div class="import-report">${prefix}: created=${report.created}, updated=${report.updated}, skipped=${report.skipped}${report.warnings.length ? '\nWarnings:\n' + report.warnings.map(deps.escapeHtml).join('\n') : ''}</div>`;
  }

  function runImport(
    card: HTMLDivElement,
    mode: ImportRequest['mode'],
    buttonSelector: '#modal-dry-run' | '#modal-apply',
    busyText: string,
    idleText: string,
    reportPrefix: string,
    onSuccess?: () => Promise<void>,
  ): void {
    const button = card.querySelector(buttonSelector);
    if (!(button instanceof HTMLButtonElement)) return;

    button.addEventListener('click', async () => {
      const path = (card.querySelector('#modal-import-path') as HTMLInputElement).value.trim();
      if (!path) return;

      button.disabled = true;
      button.textContent = busyText;

      try {
        const report = await deps.importMremote({ path, mode });
        renderImportReport(card, reportPrefix, report);
        if (onSuccess) {
          await onSuccess();
        }
      } catch (error) {
        deps.writeStatus(deps.formatError(error));
      }

      button.disabled = false;
      button.textContent = idleText;
    });
  }

  function showImportModal(): void {
    deps.showModal('Import mRemoteNG', (card) => {
      card.innerHTML += `
        <div class="form-field">
          <label>Path to mRemoteNG XML</label>
          <input id="modal-import-path" type="text" placeholder="C:\\path\\to\\confCons.xml" />
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn" id="modal-dry-run">Dry Run</button>
          <button class="btn btn-primary" id="modal-apply">Apply</button>
        </div>
        <div id="modal-import-report"></div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);

      runImport(card, 'dry_run', '#modal-dry-run', 'Running...', 'Dry Run', 'Dry run');
      runImport(
        card,
        'apply',
        '#modal-apply',
        'Importing...',
        'Apply',
        'Applied',
        async () => {
          await deps.refreshTree();
          deps.writeStatus('Import applied');
        },
      );
    });
  }

  function showExportModal(): void {
    deps.showModal('Export mRemoteNG', (card) => {
      card.innerHTML += `
        <div class="form-field">
          <label>Export path</label>
          <input id="modal-export-path" type="text" placeholder="C:\\path\\to\\export.xml" />
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-confirm">Export</button>
        </div>
      `;

      card.querySelector('#modal-cancel')!.addEventListener('click', deps.hideModal);
      card.querySelector('#modal-confirm')!.addEventListener('click', async () => {
        const path = (card.querySelector('#modal-export-path') as HTMLInputElement).value.trim();
        if (!path) return;

        const btn = card.querySelector('#modal-confirm') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Exporting...';

        try {
          await deps.exportMremote(path);
          deps.hideModal();
          deps.writeStatus('Export complete');
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          btn.disabled = false;
          btn.textContent = 'Export';
        }
      });

      deps.wireModalEnterKey(card, '#modal-confirm');
    });
  }

  return {
    showFolderModal,
    showRenameModal,
    showDeleteModal,
    showImportModal,
    showExportModal,
  };
}
