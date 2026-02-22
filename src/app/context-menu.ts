export type MenuAction =
  | { label: string; icon?: string; danger?: boolean; disabled?: boolean; action: () => void }
  | 'separator';

export type ContextMenuControllerDeps = {
  getContextMenuEl: () => HTMLDivElement | null;
};

export type ContextMenuController = {
  showContextMenu: (x: number, y: number, actions: MenuAction[]) => void;
  hideContextMenu: () => void;
  wireContextMenuDismiss: () => void;
};

export function createContextMenuController(deps: ContextMenuControllerDeps): ContextMenuController {
  function showContextMenu(x: number, y: number, actions: MenuAction[]): void {
    const contextMenuEl = deps.getContextMenuEl();
    if (!contextMenuEl) return;

    contextMenuEl.replaceChildren();

    for (const action of actions) {
      if (action === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        contextMenuEl.appendChild(sep);
        continue;
      }

      const item = document.createElement('div');
      item.className = `context-menu-item${action.danger ? ' danger' : ''}${action.disabled ? ' disabled' : ''}`;

      if (action.icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'context-menu-icon';
        iconSpan.innerHTML = action.icon;
        item.appendChild(iconSpan);
      }

      const labelSpan = document.createElement('span');
      labelSpan.textContent = action.label;
      item.appendChild(labelSpan);

      item.addEventListener('click', () => {
        if (action.disabled) return;
        hideContextMenu();
        action.action();
      });
      contextMenuEl.appendChild(item);
    }

    contextMenuEl.style.left = '0';
    contextMenuEl.style.top = '0';
    contextMenuEl.classList.add('visible');

    const rect = contextMenuEl.getBoundingClientRect();
    const clampedX = Math.min(x, window.innerWidth - rect.width - 4);
    const clampedY = Math.min(y, window.innerHeight - rect.height - 4);
    contextMenuEl.style.left = `${Math.max(0, clampedX)}px`;
    contextMenuEl.style.top = `${Math.max(0, clampedY)}px`;
  }

  function hideContextMenu(): void {
    deps.getContextMenuEl()?.classList.remove('visible');
  }

  function wireContextMenuDismiss(): void {
    document.addEventListener('click', (e) => {
      const contextMenuEl = deps.getContextMenuEl();
      if (contextMenuEl?.classList.contains('visible')) {
        if (!contextMenuEl.contains(e.target as Node)) {
          hideContextMenu();
        }
      }
    });
  }

  return {
    showContextMenu,
    hideContextMenu,
    wireContextMenuDismiss,
  };
}
