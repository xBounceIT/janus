import type { ConnectionNode, ConnectionUpsert } from '../types';

export type ConnectionProtocol = 'ssh' | 'rdp';

type RequiredConnectionFieldRule = {
  selector: string;
  message: string;
};

export type ConnectionModalControllerDeps = {
  showModal: (title: string, buildContent: (card: HTMLDivElement) => void) => void;
  hideModal: () => void;
  wireModalEnterKey: (card: HTMLElement, confirmSelector: string) => void;
  applyInputPrivacyAttributes: (root: ParentNode) => void;
  escapeAttr: (input: string) => string;
  getModalValue: (container: HTMLElement, selector: string) => string;
  getModalOptional: (container: HTMLElement, selector: string) => string | null;
  upsertConnection: (payload: ConnectionUpsert) => Promise<unknown>;
  expandedFolders: Set<string | null>;
  refreshTree: () => Promise<void>;
  writeStatus: (message: string) => void;
  formatError: (error: unknown) => string;
};

export type ConnectionModalController = {
  showConnectionModal: (protocol: ConnectionProtocol, parentId: string | null, existing?: ConnectionNode) => void;
  showEditConnectionModal: (node: ConnectionNode) => void;
};

export function createConnectionModalController(deps: ConnectionModalControllerDeps): ConnectionModalController {
  function showConnectionModal(
    protocol: ConnectionProtocol,
    parentId: string | null,
    existing?: ConnectionNode,
  ): void {
    const isEdit = !!existing;
    const title = isEdit ? `Edit ${existing!.name}` : 'New Connection';

    deps.showModal(title, (card) => {
      const activeProtocol = isEdit ? (existing!.kind as ConnectionProtocol) : protocol;

      card.innerHTML += `
        <div class="form-field">
          <label>Name</label>
          <input id="modal-conn-name" type="text" placeholder="Display name" value="${deps.escapeAttr(existing?.name ?? '')}" />
        </div>
      `;

      const tabsDiv = document.createElement('div');
      tabsDiv.className = 'protocol-tabs';
      tabsDiv.innerHTML = `
        <button class="protocol-tab${activeProtocol === 'ssh' ? ' active' : ''}" data-proto="ssh" ${isEdit ? 'disabled' : ''}>SSH</button>
        <button class="protocol-tab${activeProtocol === 'rdp' ? ' active' : ''}" data-proto="rdp" ${isEdit ? 'disabled' : ''}>RDP</button>
      `;
      card.appendChild(tabsDiv);

      const fieldsDiv = document.createElement('div');
      fieldsDiv.id = 'modal-proto-fields';
      card.appendChild(fieldsDiv);

      let currentProto = activeProtocol;
      let hasSubmitAttemptedValidation = false;
      let clearValidationListeners: Array<() => void> = [];

      const renderProtoFields = (): void => {
        if (currentProto === 'ssh') {
          renderSshFields(fieldsDiv, isEdit ? existing ?? null : null);
        } else {
          renderRdpFields(fieldsDiv, isEdit ? existing ?? null : null);
        }
        deps.applyInputPrivacyAttributes(fieldsDiv);
      };

      const refreshValidationListeners = (): void => {
        for (const clear of clearValidationListeners) {
          clear();
        }
        clearValidationListeners = [];

        for (const rule of getRequiredConnectionFieldRules(currentProto)) {
          const input = card.querySelector<HTMLInputElement>(rule.selector);
          if (!input) continue;

          const onInput = (): void => {
            if (!hasSubmitAttemptedValidation) return;

            if (input.value.trim()) {
              clearFieldInvalid(input);
            } else {
              setFieldInvalid(input, rule.message);
            }

            if (!findFirstMissingRequiredField(card, currentProto)) {
              deps.writeStatus('');
            }
          };

          input.addEventListener('input', onInput);
          clearValidationListeners.push(() => input.removeEventListener('input', onInput));
        }
      };

      renderProtoFields();
      refreshValidationListeners();

      if (!isEdit) {
        for (const btn of tabsDiv.querySelectorAll<HTMLButtonElement>('.protocol-tab')) {
          btn.addEventListener('click', () => {
            currentProto = btn.dataset.proto as ConnectionProtocol;
            for (const b of tabsDiv.querySelectorAll('.protocol-tab')) b.classList.remove('active');
            btn.classList.add('active');
            clearModalValidation(card);
            if (hasSubmitAttemptedValidation) {
              deps.writeStatus('');
            }
            renderProtoFields();
            refreshValidationListeners();
          });
        }
      }

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'modal-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn';
      cancelBtn.id = 'modal-cancel';
      cancelBtn.textContent = 'Cancel';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-primary';
      confirmBtn.id = 'modal-confirm';
      confirmBtn.textContent = isEdit ? 'Save' : 'Create';

      actionsDiv.append(cancelBtn, confirmBtn);
      card.appendChild(actionsDiv);

      cancelBtn.addEventListener('click', deps.hideModal);
      confirmBtn.addEventListener('click', async () => {
        clearModalValidation(card);
        const validation = validateConnectionRequiredFields(card, currentProto);
        if (!validation.ok) {
          hasSubmitAttemptedValidation = true;
          deps.writeStatus(validation.statusMessage);
          validation.firstInvalid?.focus();
          return;
        }
        hasSubmitAttemptedValidation = false;

        const name = (card.querySelector('#modal-conn-name') as HTMLInputElement).value.trim();

        confirmBtn.disabled = true;
        confirmBtn.textContent = isEdit ? 'Saving...' : 'Creating...';

        try {
          const payload = buildConnectionPayload(
            card,
            currentProto,
            name,
            isEdit ? existing!.id : crypto.randomUUID(),
            isEdit ? existing!.parentId : parentId,
            isEdit ? existing!.orderIndex : Date.now(),
          );

          if (!payload) {
            deps.writeStatus('Unable to save connection: required fields are missing');
            confirmBtn.disabled = false;
            confirmBtn.textContent = isEdit ? 'Save' : 'Create';
            return;
          }

          await deps.upsertConnection(payload);
          if (parentId) deps.expandedFolders.add(parentId);
          deps.hideModal();
          await deps.refreshTree();
          deps.writeStatus(isEdit ? 'Connection updated' : 'Connection created');
        } catch (error) {
          deps.writeStatus(deps.formatError(error));
          confirmBtn.disabled = false;
          confirmBtn.textContent = isEdit ? 'Save' : 'Create';
        }
      });

      deps.wireModalEnterKey(card, '#modal-confirm');
    });
  }

  function showEditConnectionModal(node: ConnectionNode): void {
    showConnectionModal(node.kind as ConnectionProtocol, node.parentId, node);
  }

  function renderSshFields(container: HTMLElement, existing: ConnectionNode | null): void {
    const ssh = existing?.ssh;
    container.innerHTML = `
      <div class="form-row">
        <div class="form-field">
          <label>Host</label>
          <input id="modal-ssh-host" type="text" placeholder="hostname or IP" value="${deps.escapeAttr(ssh?.host ?? '')}" />
        </div>
        <div class="form-field">
          <label>Port</label>
          <input id="modal-ssh-port" type="text" placeholder="22" value="${deps.escapeAttr(String(ssh?.port ?? 22))}" />
        </div>
      </div>
      <div class="form-field">
        <label>Username</label>
        <input id="modal-ssh-user" type="text" placeholder="Username" value="${deps.escapeAttr(ssh?.username ?? '')}" />
      </div>
      <div class="form-field">
        <label>Password</label>
        <input id="modal-ssh-password" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
      </div>
      <div class="form-field">
        <label>Private Key Path</label>
        <input id="modal-ssh-key" type="text" placeholder="(optional)" value="${deps.escapeAttr(ssh?.keyPath ?? '')}" />
      </div>
      <div class="form-field">
        <label>Key Passphrase</label>
        <input id="modal-ssh-key-pass" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
      </div>
      <div class="form-checkbox">
        <input id="modal-ssh-strict" type="checkbox" ${ssh?.strictHostKey !== false ? 'checked' : ''} />
        <label for="modal-ssh-strict">Strict Host Key Checking</label>
      </div>
    `;
  }

  function renderRdpFields(container: HTMLElement, existing: ConnectionNode | null): void {
    const rdp = existing?.rdp;
    const screenMode = rdp?.screenMode ?? 2;
    container.innerHTML = `
      <div class="form-row">
        <div class="form-field">
          <label>Host</label>
          <input id="modal-rdp-host" type="text" placeholder="hostname or IP" value="${deps.escapeAttr(rdp?.host ?? '')}" />
        </div>
        <div class="form-field">
          <label>Port</label>
          <input id="modal-rdp-port" type="text" placeholder="3389" value="${deps.escapeAttr(String(rdp?.port ?? 3389))}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-field">
          <label>Username</label>
          <input id="modal-rdp-user" type="text" placeholder="(optional)" value="${deps.escapeAttr(rdp?.username ?? '')}" />
        </div>
        <div class="form-field">
          <label>Domain</label>
          <input id="modal-rdp-domain" type="text" placeholder="(optional)" value="${deps.escapeAttr(rdp?.domain ?? '')}" />
        </div>
      </div>
      <div class="form-field">
        <label>Password</label>
        <input id="modal-rdp-password" type="password" placeholder="${existing ? '(unchanged if empty)' : '(optional)'}" />
      </div>
      <div class="form-field">
        <label>Screen Mode</label>
        <select id="modal-rdp-screen">
          <option value="1" ${screenMode === 1 ? 'selected' : ''}>Windowed</option>
          <option value="2" ${screenMode === 2 ? 'selected' : ''}>Fullscreen</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-field">
          <label>Width</label>
          <input id="modal-rdp-width" type="text" placeholder="(auto)" value="${deps.escapeAttr(rdp?.width != null ? String(rdp.width) : '')}" />
        </div>
        <div class="form-field">
          <label>Height</label>
          <input id="modal-rdp-height" type="text" placeholder="(auto)" value="${deps.escapeAttr(rdp?.height != null ? String(rdp.height) : '')}" />
        </div>
      </div>
    `;
  }

  function getRequiredConnectionFieldRules(proto: ConnectionProtocol): RequiredConnectionFieldRule[] {
    const rules: RequiredConnectionFieldRule[] = [{ selector: '#modal-conn-name', message: 'Name is required' }];

    if (proto === 'ssh') {
      rules.push(
        { selector: '#modal-ssh-host', message: 'Host is required' },
        { selector: '#modal-ssh-user', message: 'Username is required for SSH' },
      );
    } else {
      rules.push({ selector: '#modal-rdp-host', message: 'Host is required' });
    }

    return rules;
  }

  function findFirstMissingRequiredField(
    card: HTMLElement,
    proto: ConnectionProtocol,
  ): { input: HTMLInputElement; message: string } | null {
    for (const rule of getRequiredConnectionFieldRules(proto)) {
      const input = card.querySelector<HTMLInputElement>(rule.selector);
      if (!input) continue;
      if (!input.value.trim()) {
        return { input, message: rule.message };
      }
    }

    return null;
  }

  function validateConnectionRequiredFields(
    card: HTMLElement,
    proto: ConnectionProtocol,
  ): { ok: boolean; firstInvalid: HTMLInputElement | null; statusMessage: string } {
    let firstInvalid: HTMLInputElement | null = null;
    let statusMessage = '';

    for (const rule of getRequiredConnectionFieldRules(proto)) {
      const input = card.querySelector<HTMLInputElement>(rule.selector);
      if (!input) continue;

      if (!input.value.trim()) {
        setFieldInvalid(input, rule.message);
        if (!firstInvalid) {
          firstInvalid = input;
          statusMessage = rule.message;
        }
      }
    }

    return { ok: firstInvalid == null, firstInvalid, statusMessage };
  }

  function setFieldInvalid(input: HTMLInputElement, message: string): void {
    const field = input.closest<HTMLElement>('.form-field');
    if (!field) return;

    field.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');

    let errorEl = field.querySelector<HTMLElement>('.field-error');
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'field-error';
      field.appendChild(errorEl);
    }

    errorEl.textContent = message;
  }

  function clearFieldInvalid(input: HTMLInputElement | HTMLSelectElement): void {
    const field = input.closest<HTMLElement>('.form-field');
    if (!field) return;

    field.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    field.querySelector('.field-error')?.remove();
  }

  function clearModalValidation(card: HTMLElement): void {
    for (const field of card.querySelectorAll<HTMLElement>('.form-field.is-invalid')) {
      field.classList.remove('is-invalid');
    }

    for (const input of card.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '.form-field input[aria-invalid="true"], .form-field select[aria-invalid="true"]',
    )) {
      input.removeAttribute('aria-invalid');
    }

    for (const message of card.querySelectorAll<HTMLElement>('.field-error')) {
      message.remove();
    }
  }

  function buildConnectionPayload(
    card: HTMLElement,
    proto: ConnectionProtocol,
    name: string,
    id: string,
    parentId: string | null,
    orderIndex: number,
  ): ConnectionUpsert | null {
    if (proto === 'ssh') {
      const host = deps.getModalValue(card, '#modal-ssh-host');
      const username = deps.getModalValue(card, '#modal-ssh-user');
      if (!host) return null;
      if (!username) return null;

      const password = deps.getModalOptional(card, '#modal-ssh-password');
      const keyPath = deps.getModalOptional(card, '#modal-ssh-key');
      const keyPassphrase = deps.getModalOptional(card, '#modal-ssh-key-pass');
      const strictHostKey = (card.querySelector('#modal-ssh-strict') as HTMLInputElement)?.checked ?? true;

      return {
        id,
        parentId,
        kind: 'ssh',
        name,
        orderIndex,
        ssh: {
          host,
          port: Number(deps.getModalValue(card, '#modal-ssh-port') || '22'),
          username,
          strictHostKey,
          password,
          keyPath,
          keyPassphrase,
        },
      };
    }

    const host = deps.getModalValue(card, '#modal-rdp-host');
    if (!host) return null;

    const password = deps.getModalOptional(card, '#modal-rdp-password');
    const username = deps.getModalOptional(card, '#modal-rdp-user');
    const domain = deps.getModalOptional(card, '#modal-rdp-domain');
    const widthStr = deps.getModalValue(card, '#modal-rdp-width');
    const heightStr = deps.getModalValue(card, '#modal-rdp-height');

    return {
      id,
      parentId,
      kind: 'rdp',
      name,
      orderIndex,
      rdp: {
        host,
        port: Number(deps.getModalValue(card, '#modal-rdp-port') || '3389'),
        username,
        domain,
        screenMode: Number((card.querySelector('#modal-rdp-screen') as HTMLSelectElement)?.value ?? '2'),
        password,
        width: widthStr ? Number(widthStr) : null,
        height: heightStr ? Number(heightStr) : null,
      },
    };
  }

  return {
    showConnectionModal,
    showEditConnectionModal,
  };
}
