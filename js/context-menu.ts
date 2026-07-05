/**
 * DLOSy20 - Context Menu
 *
 * A tiny right-click menu primitive plus a registry so any control can offer
 * per-control actions ("Reset to default", "Enter value…", "MIDI Learn…").
 *
 * Controls register a provider keyed by a CSS selector; on contextmenu we walk
 * up from the target, find the nearest element matching a registered selector,
 * and show that provider's items. This keeps the menu logic here and the
 * control-specific actions in the owning module (param-control / ui-components).
 */

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

type Provider = (el: HTMLElement) => MenuItem[] | null;

const providers: { selector: string; provider: Provider }[] = [];
let _menuEl: HTMLElement | null = null;
let _installed = false;

/** Register a menu provider for elements matching `selector`. */
export function registerContextMenu(selector: string, provider: Provider): void {
  providers.push({ selector, provider });
  install();
}

function install() {
  if (_installed) return;
  _installed = true;

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    for (const { selector, provider } of providers) {
      const el = target.closest(selector) as HTMLElement | null;
      if (el) {
        const items = provider(el);
        if (items && items.length) {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, items);
          return;
        }
      }
    }
  });

  // Dismiss on any outside interaction
  document.addEventListener('pointerdown', (e) => {
    if (_menuEl && !_menuEl.contains(e.target as Node)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'pc-menu';

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'pc-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'pc-menu-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener('click', () => {
      closeMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  });

  // Provisional placement, then clamp to the viewport
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 6);
  const py = Math.min(y, window.innerHeight - r.height - 6);
  menu.style.left = Math.max(4, px) + 'px';
  menu.style.top = Math.max(4, py) + 'px';

  _menuEl = menu;
}

export function closeMenu(): void {
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
}
