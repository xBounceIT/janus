import { vaultLockIconSvg } from './icons';

type ApiClient = typeof import('../api').api;

export type ShellControllerDeps = {
  requireButton: (selector: string) => HTMLButtonElement;
  requireDiv: (selector: string) => HTMLDivElement;
  requireInput: (selector: string) => HTMLInputElement;
  requireElement: (selector: string) => HTMLElement;
  vaultLock: ApiClient['vaultLock'];
  vaultUnlock: ApiClient['vaultUnlock'];
  formatError: (error: unknown) => string;
  writeStatus: (message: string) => void;
  scheduleActiveTabResize: () => void;
  showImportModal: () => void;
  showExportModal: () => void;
  showPreferencesModal: () => void;
  showAboutModal: () => void;
  hideContextMenu: () => void;
  hideModal: () => void;
  getAppShellEl: () => HTMLDivElement | null;
  getUnlockOverlayEl: () => HTMLDivElement | null;
  getUnlockInputEl: () => HTMLInputElement | null;
  getUnlockStatusEl: () => HTMLElement | null;
  getContextMenuEl: () => HTMLDivElement | null;
  getModalOverlayEl: () => HTMLDivElement | null;
  getWorkspaceEl: () => HTMLDivElement | null;
  getFileMenuTriggerEl: () => HTMLButtonElement | null;
  getFileMenuEl: () => HTMLDivElement | null;
  getSettingsMenuTriggerEl: () => HTMLButtonElement | null;
  getSettingsMenuEl: () => HTMLDivElement | null;
  getVaultLockEl: () => HTMLButtonElement | null;
  getAppVersionEl: () => HTMLSpanElement | null;
};

export type ShellController = {
  wireToolbar: () => void;
  wireUnlockModal: () => void;
  showUnlockModal: (message?: string) => void;
  hideUnlockModal: () => void;
  wireSidebarResizer: () => void;
  wireWorkspaceResizeObserver: () => void;
  wireGlobalKeyboard: () => void;
  wireGlobalContextMenuSuppression: () => void;
  toggleFileMenu: () => void;
  setFileMenuOpen: (nextOpen: boolean) => void;
  toggleSettingsMenu: () => void;
  setSettingsMenuOpen: (nextOpen: boolean) => void;
  loadAppVersion: (label: string) => void;
  reset: () => void;
};

export function createShellController(deps: ShellControllerDeps): ShellController {
  let vaultUnlocked = false;
  let fileMenuOpen = false;
  let settingsMenuOpen = false;
  let nativeContextMenuSuppressed = false;
  let workspaceResizeObserver: ResizeObserver | null = null;

  function wireToolbar(): void {
    deps.requireButton('#vault-lock').addEventListener('click', async () => {
      if (!vaultUnlocked) return;

      try {
        await deps.vaultLock();
        showUnlockModal();
        deps.writeStatus('Vault locked');
      } catch (error) {
        deps.writeStatus(deps.formatError(error));
      }
    });

    deps.requireButton('#file-menu-trigger').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFileMenu();
    });
    deps.requireButton('#settings-menu-trigger').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSettingsMenu();
    });

    deps.requireButton('#file-import').addEventListener('click', () => {
      setFileMenuOpen(false);
      deps.showImportModal();
    });

    deps.requireButton('#file-export').addEventListener('click', () => {
      setFileMenuOpen(false);
      deps.showExportModal();
    });

    deps.requireButton('#settings-preferences').addEventListener('click', () => {
      setSettingsMenuOpen(false);
      deps.showPreferencesModal();
    });

    deps.requireButton('#settings-about').addEventListener('click', () => {
      setSettingsMenuOpen(false);
      deps.showAboutModal();
    });

    document.addEventListener('click', (event) => {
      if (!fileMenuOpen && !settingsMenuOpen) return;
      const target = event.target as Node;
      if (
        deps.getFileMenuEl()?.contains(target) ||
        deps.getFileMenuTriggerEl()?.contains(target) ||
        deps.getSettingsMenuEl()?.contains(target) ||
        deps.getSettingsMenuTriggerEl()?.contains(target)
      ) {
        return;
      }
      if (fileMenuOpen) setFileMenuOpen(false);
      if (settingsMenuOpen) setSettingsMenuOpen(false);
    });
  }

  function wireUnlockModal(): void {
    const submitEl = deps.requireButton('#unlock-submit');
    const passphraseEl = deps.requireInput('#unlock-passphrase');
    const modalStatusEl = deps.requireElement('#unlock-status');
    let busy = false;

    const setBusy = (nextBusy: boolean): void => {
      busy = nextBusy;
      submitEl.disabled = nextBusy;
      passphraseEl.disabled = nextBusy;
      submitEl.textContent = nextBusy ? 'Unlocking...' : 'Unlock';
    };

    const unlock = async (): Promise<void> => {
      if (busy) return;

      const passphrase = passphraseEl.value.trim();
      if (!passphrase) {
        modalStatusEl.textContent = 'Passphrase cannot be empty';
        passphraseEl.focus();
        return;
      }

      setBusy(true);
      modalStatusEl.textContent = '';

      try {
        await deps.vaultUnlock(passphrase);
        hideUnlockModal();
        deps.writeStatus('Vault unlocked');
      } catch (error) {
        modalStatusEl.textContent = deps.formatError(error);
        passphraseEl.focus();
        passphraseEl.select();
      } finally {
        setBusy(false);
      }
    };

    submitEl.addEventListener('click', () => {
      void unlock();
    });

    passphraseEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void unlock();
    });

    setBusy(false);
  }

  function showUnlockModal(message = ''): void {
    setVaultUnlocked(false);
    const unlockStatusEl = deps.getUnlockStatusEl();
    if (unlockStatusEl) {
      unlockStatusEl.textContent = message;
    }
    const unlockInputEl = deps.getUnlockInputEl();
    if (unlockInputEl) {
      unlockInputEl.value = '';
      window.setTimeout(() => deps.getUnlockInputEl()?.focus(), 0);
    }
  }

  function hideUnlockModal(): void {
    setVaultUnlocked(true);
    const unlockStatusEl = deps.getUnlockStatusEl();
    if (unlockStatusEl) {
      unlockStatusEl.textContent = '';
    }
    const unlockInputEl = deps.getUnlockInputEl();
    if (unlockInputEl) {
      unlockInputEl.value = '';
    }
  }

  function setVaultUnlocked(unlocked: boolean): void {
    vaultUnlocked = unlocked;
    if (!vaultUnlocked) {
      setFileMenuOpen(false);
    }
    deps.getAppShellEl()?.classList.toggle('locked', !vaultUnlocked);

    const unlockOverlayEl = deps.getUnlockOverlayEl();
    if (unlockOverlayEl) {
      unlockOverlayEl.classList.toggle('visible', !vaultUnlocked);
      unlockOverlayEl.setAttribute('aria-hidden', vaultUnlocked ? 'true' : 'false');
    }

    updateVaultLockState();
  }

  function wireSidebarResizer(): void {
    const resizer = deps.requireDiv('#sidebar-resizer');
    let dragging = false;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');

      const onMove = (ev: MouseEvent): void => {
        if (!dragging) return;
        const width = Math.min(500, Math.max(180, ev.clientX));
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
        deps.scheduleActiveTabResize();
      };

      const onUp = (): void => {
        dragging = false;
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        deps.scheduleActiveTabResize();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function wireWorkspaceResizeObserver(): void {
    workspaceResizeObserver?.disconnect();
    const workspaceEl = deps.getWorkspaceEl();
    if (!workspaceEl) return;

    workspaceResizeObserver = new ResizeObserver(() => {
      deps.scheduleActiveTabResize();
    });
    workspaceResizeObserver.observe(workspaceEl);
  }

  function wireGlobalKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;

      if (fileMenuOpen) {
        setFileMenuOpen(false);
        return;
      }
      if (settingsMenuOpen) {
        setSettingsMenuOpen(false);
        return;
      }
      if (deps.getContextMenuEl()?.classList.contains('visible')) {
        deps.hideContextMenu();
        return;
      }
      if (deps.getModalOverlayEl()?.classList.contains('visible')) {
        deps.hideModal();
      }
    });
  }

  function wireGlobalContextMenuSuppression(): void {
    if (nativeContextMenuSuppressed) return;

    document.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    nativeContextMenuSuppressed = true;
  }

  function toggleFileMenu(): void {
    const nextOpen = !fileMenuOpen;
    if (nextOpen && settingsMenuOpen) {
      setSettingsMenuOpen(false);
    }
    setFileMenuOpen(nextOpen);
  }

  function setFileMenuOpen(nextOpen: boolean): void {
    fileMenuOpen = nextOpen;

    const fileMenuEl = deps.getFileMenuEl();
    if (fileMenuEl) {
      fileMenuEl.classList.toggle('visible', nextOpen);
      fileMenuEl.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    }

    const fileMenuTriggerEl = deps.getFileMenuTriggerEl();
    if (fileMenuTriggerEl) {
      fileMenuTriggerEl.classList.toggle('open', nextOpen);
      fileMenuTriggerEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    }
  }

  function toggleSettingsMenu(): void {
    const nextOpen = !settingsMenuOpen;
    if (nextOpen && fileMenuOpen) {
      setFileMenuOpen(false);
    }
    setSettingsMenuOpen(nextOpen);
  }

  function setSettingsMenuOpen(nextOpen: boolean): void {
    settingsMenuOpen = nextOpen;

    const settingsMenuEl = deps.getSettingsMenuEl();
    if (settingsMenuEl) {
      settingsMenuEl.classList.toggle('visible', nextOpen);
      settingsMenuEl.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    }

    const settingsMenuTriggerEl = deps.getSettingsMenuTriggerEl();
    if (settingsMenuTriggerEl) {
      settingsMenuTriggerEl.classList.toggle('open', nextOpen);
      settingsMenuTriggerEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    }
  }

  function updateVaultLockState(): void {
    const vaultLockEl = deps.getVaultLockEl();
    if (!vaultLockEl) return;

    const locked = !vaultUnlocked;
    vaultLockEl.disabled = locked;
    vaultLockEl.classList.toggle('is-locked', locked);
    vaultLockEl.setAttribute('aria-label', locked ? 'Vault locked' : 'Lock vault');
    vaultLockEl.title = locked ? 'Vault locked' : 'Lock vault';
    vaultLockEl.innerHTML = vaultLockIconSvg(locked);
  }

  function loadAppVersion(label: string): void {
    const target = deps.getAppVersionEl();
    if (!target) return;
    target.textContent = label;
  }

  function reset(): void {
    workspaceResizeObserver?.disconnect();
    workspaceResizeObserver = null;
    vaultUnlocked = false;
    fileMenuOpen = false;
    settingsMenuOpen = false;
  }

  return {
    wireToolbar,
    wireUnlockModal,
    showUnlockModal,
    hideUnlockModal,
    wireSidebarResizer,
    wireWorkspaceResizeObserver,
    wireGlobalKeyboard,
    wireGlobalContextMenuSuppression,
    toggleFileMenu,
    setFileMenuOpen,
    toggleSettingsMenu,
    setSettingsMenuOpen,
    loadAppVersion,
    reset,
  };
}
