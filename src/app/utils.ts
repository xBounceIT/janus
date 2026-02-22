export function parseCargoPackageVersion(toml: string): string | null {
  let inPackageSection = false;
  const lines = toml.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inPackageSection = trimmed === '[package]';
      continue;
    }

    if (!inPackageSection) continue;

    const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function getModalValue(container: HTMLElement, selector: string): string {
  const el = container.querySelector<HTMLInputElement>(selector);
  return el?.value.trim() ?? '';
}

export function getModalOptional(container: HTMLElement, selector: string): string | null {
  const v = getModalValue(container, selector);
  return v.length > 0 ? v : null;
}

export function wireModalEnterKey(card: HTMLElement, confirmSelector: string): void {
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      card.querySelector<HTMLButtonElement>(confirmSelector)?.click();
    }
  });
}

export function applyInputPrivacyAttributes(root: ParentNode): void {
  const forms = root.querySelectorAll<HTMLFormElement>('form');
  for (const form of forms) {
    form.setAttribute('autocomplete', 'off');
  }

  const inputs = root.querySelectorAll<HTMLInputElement>('input');
  for (const input of inputs) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();

    if (type === 'hidden' || type === 'checkbox' || type === 'radio') {
      continue;
    }

    if (type === 'password') {
      input.setAttribute('autocomplete', 'new-password');
    } else {
      input.setAttribute('autocomplete', 'off');
    }

    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
  }
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttr(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
