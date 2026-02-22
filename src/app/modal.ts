export type ModalControllerDeps = {
  getModalOverlayEl: () => HTMLDivElement | null;
  getModalOnHide: () => (() => void | Promise<void>) | null;
  setModalOnHide: (handler: (() => void | Promise<void>) | null) => void;
  applyInputPrivacyAttributes: (root: ParentNode) => void;
};

export type ModalController = {
  showModal: (title: string, buildContent: (card: HTMLDivElement) => void) => void;
  hideModal: () => void;
};

export function createModalController(deps: ModalControllerDeps): ModalController {
  function showModal(title: string, buildContent: (card: HTMLDivElement) => void): void {
    const modalOverlayEl = deps.getModalOverlayEl();
    if (!modalOverlayEl) return;
    deps.setModalOnHide(null);

    const card = document.createElement('div');
    card.className = 'modal-card';

    const h2 = document.createElement('h2');
    h2.textContent = title;
    card.appendChild(h2);

    buildContent(card);
    deps.applyInputPrivacyAttributes(card);

    modalOverlayEl.replaceChildren(card);
    modalOverlayEl.classList.add('visible');

    const firstInput = card.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    if (firstInput) {
      window.setTimeout(() => firstInput.focus(), 0);
    }

    modalOverlayEl.addEventListener(
      'click',
      (e) => {
        if (e.target === modalOverlayEl) {
          hideModal();
        }
      },
      { once: true },
    );
  }

  function hideModal(): void {
    const onHide = deps.getModalOnHide();
    deps.setModalOnHide(null);
    deps.getModalOverlayEl()?.classList.remove('visible');
    if (onHide) {
      Promise.resolve(onHide()).catch(() => undefined);
    }
  }

  return {
    showModal,
    hideModal,
  };
}
