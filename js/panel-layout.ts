/**
 * DLOSy20 - Panel Layout Manager
 * Drag-to-resize (column/row sizing) and drag-to-reorder for the five
 * main UI panels (SYNTH / SEQUENCER tabs / EFFECTS / VCO LOOP / DRAWING).
 * Layout (sizes + order) is persisted to localStorage.
 */

interface ResizeHandleConfig {
  varName: string;
  sign: number;
  target: 'before' | 'after';
}

interface LayoutData {
  sizes: Record<string, string>;
  order: Record<string, string[]>;
  hidden: Record<string, boolean>;
}

// The three secondary top-row blocks that can be shown/hidden. VCO LOOP and
// DRAWING MODE (the bottom row) are the main panels and are always visible.
const TOGGLEABLE_PANELS: { id: string; label: string }[] = [
  { id: 'panel-synth', label: 'SETTINGS' },
  { id: 'panel-center', label: 'CENTER' },
  { id: 'panel-effects', label: 'EFFECTS' },
];

interface PanelGroup {
  containerId: string;
  container: HTMLElement;
  order: string[];
  resizeHandles: ResizeHandleConfig[];
}

class PanelLayout {
  storageKey: string;
  layout: LayoutData;
  _chips: Record<string, HTMLButtonElement> = {};

  constructor() {
    this.storageKey = 'dlosy20_panel_layout';
    this.layout = this.loadLayout();
  }

  init() {
    this.applySizes();
    this.setupGroup('synth-main', ['panel-synth', 'panel-center', 'panel-effects'], [
      { varName: '--col-left', sign: 1, target: 'before' },
      { varName: '--col-right', sign: -1, target: 'after' },
    ]);
    this.setupGroup('panel-bottom', ['vco-loop-panel', 'drawing-panel'], [
      { varName: '--col-bottom-1', sign: 1, target: 'before' },
    ]);
    this.buildRowHandle();
    this.buildToggleBar();
    this.buildResetButton();
    this.applyTopVisibility();
  }

  // ===== PERSISTENCE =====

  // Default view: the secondary blocks start HIDDEN so the app opens focused on
  // VCO LOOP + DRAWING MODE. A saved layout with an explicit `hidden` map (from
  // the user toggling chips) overrides this.
  defaultHidden(): Record<string, boolean> {
    const h: Record<string, boolean> = {};
    TOGGLEABLE_PANELS.forEach(({ id }) => { h[id] = true; });
    return h;
  }

  loadLayout(): LayoutData {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          sizes: parsed.sizes || {},
          order: parsed.order || {},
          // Respect an explicit saved map; fall back to the hidden-by-default view.
          hidden: parsed.hidden || this.defaultHidden(),
        };
      }
    } catch (e) {}
    return { sizes: {}, order: {}, hidden: this.defaultHidden() };
  }

  saveLayout() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.layout));
  }

  resetLayout() {
    localStorage.removeItem(this.storageKey);
    location.reload();
  }

  applySizes() {
    Object.entries(this.layout.sizes || {}).forEach(([varName, value]) => {
      if (value) document.documentElement.style.setProperty(varName, value);
    });
  }

  // ===== GROUP SETUP (one resizable/reorderable row of panels) =====

  setupGroup(containerId: string, defaultPanelIds: string[], resizeHandles: ResizeHandleConfig[]) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const savedOrder = (this.layout.order && this.layout.order[containerId]) || defaultPanelIds;
    const order = savedOrder.filter((id) => defaultPanelIds.includes(id));
    defaultPanelIds.forEach((id) => {
      if (!order.includes(id)) order.push(id);
    });

    const group = { containerId, container, order, resizeHandles };
    this.renderGroup(group);
    this.makeReorderable(group);
  }

  // Rebuilds the container's children as: panel, handle, panel, handle, panel
  // so resize handles always sit between the *current* slot order.
  renderGroup(group: PanelGroup) {
    const { container, order } = group;
    container.querySelectorAll(':scope > .panel-resize-handle').forEach((h) => h.remove());

    const panels = order.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    panels.forEach((panel, i) => {
      container.appendChild(panel);
      if (i < panels.length - 1) {
        container.appendChild(this.createColumnHandle(group, i));
      }
    });
  }

  // ===== COLUMN RESIZE =====

  createColumnHandle(group: PanelGroup, afterIndex: number) {
    const config = group.resizeHandles[afterIndex];
    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle';
    if (!config) return handle; // safety: no resize behavior defined for this gap

    const getTargetEl = () => {
      const idx = config.target === 'before' ? afterIndex : afterIndex + 1;
      return document.getElementById(group.order[idx]);
    };

    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent) => {
      const delta = config.sign * (e.clientX - startX);
      const newWidth = Math.max(160, Math.min(window.innerWidth * 0.45, startWidth + delta));
      document.documentElement.style.setProperty(config.varName, newWidth + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      document.body.classList.remove('resizing-col');
      this.layout.sizes = this.layout.sizes || {};
      this.layout.sizes[config.varName] = document.documentElement.style.getPropertyValue(config.varName);
      this.saveLayout();
    };

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const targetEl = getTargetEl();
      if (!targetEl) return;
      startX = e.clientX;
      startWidth = targetEl.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('resizing-col');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return handle;
  }

  // ===== ROW RESIZE (top section vs. bottom section height) =====

  buildRowHandle() {
    const app = document.getElementById('synth-app');
    const main = document.getElementById('synth-main');
    const bottom = document.getElementById('panel-bottom');
    if (!app || !main || !bottom) return;

    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle row-handle';
    app.insertBefore(handle, bottom);

    let startY = 0;
    let startHeight = 0;

    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY; // dragging up grows the bottom row
      const maxHeight = window.innerHeight * 0.7;
      const newHeight = Math.max(100, Math.min(maxHeight, startHeight + delta));
      document.documentElement.style.setProperty('--row-bottom-height', newHeight + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      document.body.classList.remove('resizing-row');
      this.layout.sizes = this.layout.sizes || {};
      this.layout.sizes['--row-bottom-height'] = document.documentElement.style.getPropertyValue('--row-bottom-height');
      this.saveLayout();
    };

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = bottom.getBoundingClientRect().height;
      handle.classList.add('active');
      document.body.classList.add('resizing-row');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ===== DRAG-TO-REORDER =====

  makeReorderable(group: PanelGroup) {
    let draggedId: string | null = null;

    group.order.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      const grip = document.createElement('span');
      grip.className = 'panel-drag-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag to reorder';
      el.appendChild(grip);

      el.draggable = false;
      grip.addEventListener('mousedown', () => {
        el.draggable = true;
      });

      el.addEventListener('dragstart', () => {
        draggedId = id;
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.draggable = false;
        el.classList.remove('dragging');
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (draggedId && draggedId !== id) el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (!draggedId || draggedId === id) return;

        const fromIdx = group.order.indexOf(draggedId);
        const toIdx = group.order.indexOf(id);
        group.order.splice(fromIdx, 1);
        group.order.splice(toIdx, 0, draggedId);
        draggedId = null;

        this.renderGroup(group);
        this.layout.order = this.layout.order || {};
        this.layout.order[group.containerId] = group.order.slice();
        this.saveLayout();
        // Reorder recreated the resize handles; re-apply show/hide state so the
        // grid template + handle visibility stay consistent with reality.
        if (group.containerId === 'synth-main') this.applyTopVisibility();
      });
    });
  }

  // ===== SHOW / HIDE SECONDARY PANELS =====

  buildToggleBar() {
    const header = document.getElementById('synth-header');
    if (!header) return;

    const bar = document.createElement('div');
    bar.className = 'panel-toggle-bar';

    const label = document.createElement('span');
    label.className = 'panel-toggle-label';
    label.textContent = 'VIEW';
    bar.appendChild(label);

    TOGGLEABLE_PANELS.forEach(({ id, label: text }) => {
      const chip = document.createElement('button');
      chip.className = 'panel-toggle-chip';
      chip.textContent = text;
      chip.title = `${text} パネルの表示 / 非表示`;
      chip.addEventListener('click', () => this.togglePanel(id));
      this._chips[id] = chip;
      bar.appendChild(chip);
    });

    header.appendChild(bar);
  }

  togglePanel(id: string) {
    this.layout.hidden = this.layout.hidden || {};
    this.layout.hidden[id] = !this.layout.hidden[id];
    this.saveLayout();
    this.applyTopVisibility();
  }

  // Reflect the persisted hidden-state onto the DOM: hide the chosen panels,
  // hide any resize handle next to a hidden panel, rebuild the top-row grid
  // template from what's left, and — when nothing is left — collapse the whole
  // top row so VCO LOOP + DRAWING MODE grow to fill the screen.
  applyTopVisibility() {
    const main = document.getElementById('synth-main');
    if (!main) return;
    const hidden = this.layout.hidden || {};

    // 1) Panels
    TOGGLEABLE_PANELS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) el.style.display = hidden[id] ? 'none' : '';
    });

    // 2) Resize handles: a handle is only meaningful between two visible panels.
    const children = Array.from(main.children) as HTMLElement[];
    children.forEach((child, i) => {
      if (!child.classList.contains('panel-resize-handle')) return;
      const prev = children[i - 1];
      const next = children[i + 1];
      const gone = (el?: HTMLElement) => !el || el.style.display === 'none';
      child.style.display = (gone(prev) || gone(next)) ? 'none' : '';
    });

    // 3) Rebuild the grid template from the currently visible children, so hidden
    //    panels don't leave empty columns.
    const track = (el: HTMLElement) => {
      if (el.classList.contains('panel-resize-handle')) return '10px';
      if (el.id === 'panel-synth') return 'var(--col-left, 260px)';
      if (el.id === 'panel-effects') return 'var(--col-right, 280px)';
      return 'minmax(0, 1fr)'; // panel-center (or any flexible panel)
    };
    const visible = children.filter(c => c.style.display !== 'none');
    main.style.gridTemplateColumns = visible.map(track).join(' ');

    // 4) Collapse the top row entirely when every secondary panel is hidden.
    const anyVisible = TOGGLEABLE_PANELS.some(({ id }) => !hidden[id]);
    document.body.classList.toggle('top-collapsed', !anyVisible);

    // 5) Sync chip highlight (active = panel visible).
    TOGGLEABLE_PANELS.forEach(({ id }) => {
      this._chips[id]?.classList.toggle('active', !hidden[id]);
    });

    // 6) Panels that were resized/re-shown may need a redraw (canvas re-measure).
    window.dispatchEvent(new Event('resize'));
  }

  // ===== RESET BUTTON =====

  buildResetButton() {
    const header = document.querySelector('.header-controls');
    if (!header) return;
    const btn = document.createElement('button');
    btn.id = 'btn-reset-layout';
    btn.className = 'transport-btn';
    btn.textContent = '⟲';
    btn.title = 'Reset Panel Layout';
    btn.addEventListener('click', () => {
      if (confirm('パネルのサイズ・配置をリセットしますか？')) {
        this.resetLayout();
      }
    });
    header.appendChild(btn);
  }
}

export const panelLayout = new PanelLayout();
