/**
 * DLOSy20 - Panel Layout Manager
 * Drag-to-resize (column/row sizing) and drag-to-reorder for the five
 * main UI panels (SYNTH / SEQUENCER tabs / EFFECTS / VCO LOOP / DRAWING).
 * Layout (sizes + order) is persisted to localStorage.
 */

import { showMenu, registerContextMenu, MenuItem } from './context-menu';

interface ResizeHandleConfig {
  varName: string;
  sign: number;
  target: 'before' | 'after';
}

interface LayoutData {
  sizes: Record<string, string>;
  order: Record<string, string[]>;
  hidden: Record<string, boolean>;
  collapsed: Record<string, boolean>;
  settingsFloat: boolean;
  settingsFloatPos: { left: number; top: number } | null;
  // Per floatable CENTER tab (phase / glyph): 'dock' (default, in the tab strip),
  // 'float' (own overlay window) or 'hidden' (not shown anywhere). Plus where
  // each floating window last sat (viewport-relative).
  tabMode: Record<string, string>;
  tabFloatPos: Record<string, { left: number; top: number }>;
  v: number; // layout schema version, for one-time default migrations
}

// Bump when new defaults should be force-applied ONCE to existing saved layouts.
// v1: unified float VIEW bar — SETTINGS floats, EFFECTS rests hidden.
// v2: chip = show/hide (never dock). VCO/DRAWING dock-on; ARP/EASE/PHASE/GLYPH/
//     EFFECTS hidden-off.
// v3: SETTINGS also starts hidden-off (shows as float when toggled on).
const LAYOUT_VERSION = 3;

// (The old red show/hide chips are gone — everything is a float chip now.) This
// array stays only so the legacy display/grid helpers can iterate it; it is
// intentionally empty. SETTINGS + EFFECTS are float chips (see below); CENTER's
// tabs are individually floatable so no whole-CENTER toggle is needed.
const TOGGLEABLE_PANELS: { id: string; label: string }[] = [];

// CENTER tabs that can be popped out of the panel-center tab strip into their
// own floating window. `id` matches the tab's data-tab / `center-tab-<id>`
// content element. Chip/✕ toggle float ↔ hidden; dock is explicit (right-click).
const FLOATABLE_TABS: { id: string; label: string }[] = [
  { id: 'arp',   label: 'ARP'   },
  { id: 'ease',  label: 'EASE'  },
  { id: 'phase', label: 'PHASE' },
  { id: 'glyph', label: 'GLYPH' },
];

// Whole panels (grid items) that can be popped out into a floating window. `id`
// is the panel element; `group` is the layout group whose grid must be recomputed;
// `on` is the SHOWN mode the chip toggles to (EFFECTS shows floating; VCO/DRAWING
// show docked). The chip's OFF state is always 'hidden'.
const FLOATABLE_PANELS: { id: string; label: string; group: string; on: string }[] = [
  { id: 'panel-effects',  label: 'EFFECTS',  group: 'synth-main',  on: 'float' },
  { id: 'vco-loop-panel', label: 'VCO LOOP', group: 'panel-bottom', on: 'dock' },
  { id: 'drawing-panel',  label: 'DRAWING',  group: 'panel-bottom', on: 'dock' },
];

const isFloatablePanel = (id: string) => FLOATABLE_PANELS.some(p => p.id === id);
// The mode a unit shows in when its chip is toggled ON (OFF is always 'hidden').
const shownMode = (id: string) => FLOATABLE_PANELS.find(p => p.id === id)?.on || 'float';

// Units that start hidden (chip OFF) by default — everything except SETTINGS
// (floats-on) and VCO LOOP / DRAWING (dock-on).
const DEFAULT_HIDDEN_UNITS = ['arp', 'ease', 'phase', 'glyph', 'panel-effects'];

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
  _groups: Record<string, PanelGroup> = {}; // by containerId, for panel float re-render

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
    this.initPanelCollapse();
    this.applySettingsFloat();
    this.initTabFloats();
    this.applyTopVisibility();

    // Keep floating overlays (SETTINGS + any popped-out CENTER tab) inside the
    // viewport on window resize.
    window.addEventListener('resize', () => {
      if (this.layout.settingsFloat) {
        const p = document.getElementById('panel-synth');
        if (p) this.applyFloatPos(p);
      }
      [...FLOATABLE_TABS, ...FLOATABLE_PANELS].forEach(({ id }) => {
        if (this.getTabMode(id) === 'float') this.positionTabFloat(id);
      });
    });
  }

  // ===== PANEL COLLAPSE (double-click title) =====
  // Double-clicking a panel's title bar collapses its body to just the header
  // (a quick way to reclaim space without fully hiding the panel). Persisted.
  initPanelCollapse() {
    const collapsed = this.layout.collapsed || (this.layout.collapsed = {});
    document.querySelectorAll<HTMLElement>('.panel').forEach(panel => {
      if (!panel.id) return;
      if (collapsed[panel.id]) panel.classList.add('panel-collapsed');
      // Delegate: dblclick on this panel's own title (not nested UIs)
      panel.addEventListener('dblclick', (e) => {
        const t = e.target as HTMLElement;
        const title = t.closest('.panel-title');
        if (!title || title.closest('.panel') !== panel) return;
        // The title bar hosts interactive controls (voice tabs, wave/VOL,
        // COPY/PASTE, tool buttons…). Double-clicking THOSE must NOT collapse
        // the panel — that was firing accidentally and hiding the VCO editor.
        // Only a double-click on the bare title area toggles collapse.
        if (t.closest('button, input, select, textarea, canvas, a, [draggable="true"], .knob, .pc-readout, .pattern-btn')) return;
        const now = panel.classList.toggle('panel-collapsed');
        this.layout.collapsed[panel.id] = now;
        this.saveLayout();
        window.dispatchEvent(new Event('resize'));
      });
    });
  }

  // ===== SETTINGS FLOAT (popover) MODE =====
  // The SETTINGS panel has three modes like every other unit: 'float' (fixed
  // overlay), 'dock' (grid column) and 'hidden'. It keeps its own fixed-position
  // float mechanism (rather than the move-into-window path); float vs dock is
  // `settingsFloat`, and hidden is tracked in the hidden map under 'panel-synth'.
  _settingsShown() { return !this.layout.hidden?.['panel-synth']; }

  setSettingsMode(mode: string) {
    this.layout.hidden = this.layout.hidden || {};
    if (mode === 'hidden') {
      this.layout.hidden['panel-synth'] = true;
    } else {
      this.layout.hidden['panel-synth'] = false;
      this.layout.settingsFloat = (mode === 'float');
    }
    this.saveLayout();
    this.applySettingsFloat();
    this.applyTopVisibility();
  }

  // Kept for the audio-settings modal's Docked/Floating dropdown.
  setSettingsFloat(on: boolean) { this.setSettingsMode(on ? 'float' : 'dock'); }

  settingsMenu(): MenuItem[] {
    const shown = this._settingsShown();
    const cur = !shown ? 'hidden' : (this.layout.settingsFloat ? 'float' : 'dock');
    const item = (m: string, label: string): MenuItem => ({
      label: (cur === m ? '● ' : '○ ') + label,
      disabled: cur === m,
      action: () => this.setSettingsMode(m),
    });
    return [item('float', 'フロート'), item('dock', 'ドック'), item('hidden', '非表示')];
  }

  applySettingsFloat() {
    const shown = this._settingsShown();
    const float = shown && !!this.layout.settingsFloat;
    document.body.classList.toggle('settings-float', float);
    this._chips['tab-panel-synth']?.classList.toggle('active', shown); // lit = shown
    const panel = document.getElementById('panel-synth');
    if (!panel) return;
    // Hidden = display:none (the grid recompute in applyTopVisibility drops it).
    if (panel.parentElement === document.getElementById('synth-main')) {
      panel.style.display = shown ? '' : 'none';
    }
    if (float) {
      this.ensureFloatHeader(panel);
      this.applyFloatPos(panel);
    } else {
      // Drop the fixed-position offsets so the docked grid layout is clean.
      panel.style.left = '';
      panel.style.top = '';
    }
  }

  // Clamp + apply the saved floating position (viewport-relative).
  applyFloatPos(panel: HTMLElement) {
    const pos = this.layout.settingsFloatPos;
    if (!pos) return;
    const w = panel.offsetWidth || 280;
    const left = Math.max(0, Math.min(window.innerWidth - w, pos.left));
    const top = Math.max(0, Math.min(window.innerHeight - 40, pos.top));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  // Add a draggable header to the floating SETTINGS panel (once). It is only
  // visible in float mode (CSS) and lets the user reposition the overlay.
  ensureFloatHeader(panel: HTMLElement) {
    if (panel.querySelector(':scope > .panel-float-header')) return;

    const header = document.createElement('div');
    header.className = 'panel-float-header';
    header.innerHTML = `<span class="pfh-grip">⠿</span><span class="pfh-title">SETTINGS</span>`;
    panel.insertBefore(header, panel.firstChild);

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const onMove = (e: PointerEvent) => {
      const w = panel.offsetWidth;
      const left = Math.max(0, Math.min(window.innerWidth - w, startLeft + (e.clientX - startX)));
      const top = Math.max(0, Math.min(window.innerHeight - 40, startTop + (e.clientY - startY)));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    };
    const onUp = (e: PointerEvent) => {
      header.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      header.classList.remove('dragging');
      this.layout.settingsFloatPos = {
        left: parseInt(panel.style.left, 10) || 0,
        top: parseInt(panel.style.top, 10) || 0,
      };
      this.saveLayout();
    };
    header.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = r.left; startTop = r.top;
      header.setPointerCapture(e.pointerId);
      header.classList.add('dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // ===== CENTER TAB FLOAT (pop-out) MODE =====
  // PHASE / GLYPH can be lifted out of the panel-center tab strip into their own
  // floating window (like the SETTINGS overlay), so they stay visible while the
  // user works elsewhere — independent of whether the CENTER panel is shown.

  // Restore non-default float modes (tabs + panels) + wire tab right-click menu.
  initTabFloats() {
    FLOATABLE_TABS.forEach(({ id }) => {
      if (this.getTabMode(id) !== 'dock') this.applyTabMode(id);
    });
    FLOATABLE_PANELS.forEach(({ id }) => {
      if (this.getTabMode(id) !== 'dock') this.applyPanelMode(id);
    });
    // Sync every chip's lit state (dock-default panels like VCO/DRAWING never hit
    // applyPanelMode above, so light them here).
    [...FLOATABLE_TABS, ...FLOATABLE_PANELS].forEach(({ id }) => this.updateTabChip(id));
    this._syncCenterVisibility();
    // Right-clicking a floatable tab button offers the Float / Dock / Hide menu.
    // (Whole panels are controlled from their VIEW chip — left-click toggles
    // float↔off, right-click opens the same menu — and the float window's ✕;
    // a panel-body right-click would shadow the controls' own context menus.)
    registerContextMenu('.center-tab', (el) => {
      const tab = (el as HTMLElement).dataset.tab || '';
      if (!FLOATABLE_TABS.some(t => t.id === tab)) return null;
      return this.tabModeMenu(tab);
    });
  }

  // Hide the CENTER panel entirely when none of its tabs are docked (all floated
  // or hidden) — otherwise an empty tab strip lingers as a blank dock. Shown
  // again the moment any tab is docked back.
  _syncCenterVisibility() {
    const center = document.getElementById('panel-center');
    if (!center) return;
    const anyDocked = FLOATABLE_TABS.some(t => this.getTabMode(t.id) === 'dock');
    center.style.display = anyDocked ? '' : 'none';
    this.applyTopVisibility(); // recompute the top grid (+ collapse if now empty)
  }

  getTabMode(id: string): string {
    return this.layout.tabMode[id] || 'dock';
  }

  // Menu shared by the VIEW chip and the right-click menu: Float / Dock / 非表示
  // for every floatable unit (tabs and panels alike).
  tabModeMenu(id: string): MenuItem[] {
    const mode = this.getTabMode(id);
    const item = (m: string, label: string): MenuItem => ({
      label: (mode === m ? '● ' : '○ ') + label,
      disabled: mode === m,
      action: () => this.setTabMode(id, m),
    });
    return [item('float', 'フロート'), item('dock', 'ドック'), item('hidden', '非表示')];
  }

  setTabMode(id: string, mode: string) {
    const known = FLOATABLE_TABS.some(t => t.id === id) || isFloatablePanel(id);
    if (!known) return;
    this.layout.tabMode[id] = mode;
    this.saveLayout();
    if (isFloatablePanel(id)) {
      this.applyPanelMode(id);
    } else {
      this.applyTabMode(id);
      this._syncCenterVisibility(); // an all-tabs-off state collapses CENTER
    }
  }

  // Reflect a tab's mode onto the DOM: 'float' (overlay window), 'dock' (back in
  // the tab strip, revealed + active) or 'hidden' (not shown anywhere).
  applyTabMode(id: string) {
    const mode = this.getTabMode(id);
    const content = document.getElementById(`center-tab-${id}`);
    const tabBtn = document.querySelector<HTMLElement>(`.center-tab[data-tab="${id}"]`);
    if (!content) return;

    if (mode === 'float') {
      const win = this.ensureTabFloatWindow(id);
      if (content.parentElement !== win) win.appendChild(content);
      this.positionTabFloat(id);
      // Hide the docked tab button while floating; if it was the active tab, fall
      // back to the first still-visible tab so panel-center isn't left blank.
      if (tabBtn) {
        const wasActive = tabBtn.classList.contains('active');
        tabBtn.style.display = 'none';
        if (wasActive) {
          const fallback = Array.from(document.querySelectorAll<HTMLElement>('.center-tab'))
            .find(b => b.style.display !== 'none');
          fallback?.click();
        }
      }
    } else {
      // dock / hidden: return the content to the tab strip, drop the float window.
      const center = document.getElementById('panel-center');
      if (center && content.parentElement !== center) center.appendChild(content);
      content.classList.remove('active');
      document.getElementById(`tab-float-${id}`)?.remove();
      if (mode === 'hidden') {
        // Just gone: keep the tab button hidden + content inactive. Bring it back
        // via the VIEW chip (→ float) or right-click → ドック.
        if (tabBtn) tabBtn.style.display = 'none';
      } else {
        // dock (explicit): reveal CENTER + make it the active tab.
        if (tabBtn) {
          tabBtn.style.display = '';
          this.layout.hidden = this.layout.hidden || {};
          if (this.layout.hidden['panel-center']) {
            this.layout.hidden['panel-center'] = false;
            this.saveLayout();
            this.applyTopVisibility();
          }
          tabBtn.click(); // switch to the freshly-docked tab so it's on screen
        }
      }
    }
    this.updateTabChip(id);
    this._pokeRelayout(); // canvas re-measure (phase pad / EASE graph etc.)
  }

  // Reflect a floatable PANEL's mode: 'float' (moved into an overlay window),
  // 'dock' (back in its row) or 'hidden' (in its row's DOM but display:none, so
  // the grid recompute drops it).
  applyPanelMode(id: string) {
    const mode = this.getTabMode(id);
    const panel = document.getElementById(id);
    const def = FLOATABLE_PANELS.find(p => p.id === id);
    if (!panel || !def) return;

    if (mode === 'float') {
      panel.style.display = '';
      const win = this.ensureTabFloatWindow(id);
      if (panel.parentElement !== win) win.appendChild(panel);
      this.positionTabFloat(id);
    } else {
      // dock / hidden: re-render the group FIRST — renderGroup does
      // container.appendChild on the panel, which MOVES it out of its float
      // window back into its ordered slot. Only THEN remove the now-empty window.
      // (Removing the window first would delete the panel along with it — it's the
      // window's child — which made the panel vanish and later floats show empty.)
      const group = this._groups[def.group];
      if (group) this.renderGroup(group);
      document.getElementById(`tab-float-${id}`)?.remove();
      panel.style.display = (mode === 'hidden') ? 'none' : '';
    }
    // Recompute the affected row's grid so remaining panels fill the space.
    if (def.group === 'synth-main') this.applyTopVisibility();
    else this.applyBottomVisibility();
    this.saveLayout();
    this.updateTabChip(id);
    this._pokeRelayout();
  }

  // Rebuild #panel-bottom's grid template from whatever panels are still docked
  // there (VCO LOOP / DRAWING). Mirrors applyTopVisibility for the bottom row.
  applyBottomVisibility() {
    const bottom = document.getElementById('panel-bottom');
    if (!bottom) return;
    const children = Array.from(bottom.children) as HTMLElement[];
    const isPanel = (el?: HTMLElement) => !!el && el.classList.contains('panel');

    // A handle is only meaningful between two docked panels.
    children.forEach((child, i) => {
      if (!child.classList.contains('panel-resize-handle')) return;
      child.style.display = (isPanel(children[i - 1]) && isPanel(children[i + 1])) ? '' : 'none';
    });

    const panelCount = children.filter(isPanel).length;
    const track = (el: HTMLElement) => {
      if (el.classList.contains('panel-resize-handle')) return '10px';
      // Only honour the saved split when both panels are present; a lone panel fills.
      if (el.id === 'vco-loop-panel' && panelCount > 1) return 'var(--col-bottom-1, 1fr)';
      return 'minmax(0, 1fr)';
    };
    const gridChildren = children.filter(c =>
      c.classList.contains('panel-resize-handle') ? c.style.display !== 'none' : isPanel(c));
    bottom.style.gridTemplateColumns = gridChildren.map(track).join(' ');
  }

  // ✕ on a float window hides the unit (OFF = hidden for everything; dock is a
  // deliberate right-click choice).
  closeFloat(id: string) {
    this.setTabMode(id, 'hidden');
  }

  ensureTabFloatWindow(id: string): HTMLElement {
    const existing = document.getElementById(`tab-float-${id}`);
    if (existing) return existing;

    const label = FLOATABLE_TABS.find(t => t.id === id)?.label
      || FLOATABLE_PANELS.find(p => p.id === id)?.label || id.toUpperCase();
    const win = document.createElement('div');
    win.className = 'tab-float' + (isFloatablePanel(id) ? ' tab-float-panel' : '');
    win.id = `tab-float-${id}`;

    const header = document.createElement('div');
    header.className = 'panel-float-header';
    header.innerHTML = `<span class="pfh-grip">⠿</span><span class="pfh-title">${label}</span>`;
    const close = document.createElement('button');
    close.className = 'pfh-close';
    close.title = '非表示（ドックにするには右クリック→ドック）';
    close.textContent = '✕';
    close.addEventListener('click', () => this.closeFloat(id));
    header.appendChild(close);
    win.appendChild(header);

    document.body.appendChild(win);
    this.makeTabFloatDraggable(id, win, header);
    return win;
  }

  // Clamp + apply the floating window's position (saved, or a cascaded default).
  positionTabFloat(id: string) {
    const win = document.getElementById(`tab-float-${id}`);
    if (!win) return;
    const tabIdx = FLOATABLE_TABS.findIndex(t => t.id === id);
    const idx = Math.max(0, tabIdx >= 0 ? tabIdx : FLOATABLE_PANELS.findIndex(p => p.id === id));
    const saved = this.layout.tabFloatPos[id];
    const w = win.offsetWidth || 360;
    // Default: cascade near the right edge so multiple pop-outs don't fully overlap.
    const rawLeft = saved ? saved.left : Math.max(0, window.innerWidth - w - 24 - idx * 28);
    const rawTop = saved ? saved.top : 90 + idx * 28;
    win.style.left = Math.max(0, Math.min(window.innerWidth - w, rawLeft)) + 'px';
    win.style.top = Math.max(0, Math.min(window.innerHeight - 40, rawTop)) + 'px';
  }

  makeTabFloatDraggable(id: string, win: HTMLElement, header: HTMLElement) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const onMove = (e: PointerEvent) => {
      const w = win.offsetWidth;
      const left = Math.max(0, Math.min(window.innerWidth - w, startLeft + (e.clientX - startX)));
      const top = Math.max(0, Math.min(window.innerHeight - 40, startTop + (e.clientY - startY)));
      win.style.left = left + 'px';
      win.style.top = top + 'px';
    };
    const onUp = (e: PointerEvent) => {
      header.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      header.classList.remove('dragging');
      this.layout.tabFloatPos[id] = {
        left: parseInt(win.style.left, 10) || 0,
        top: parseInt(win.style.top, 10) || 0,
      };
      this.saveLayout();
    };
    header.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.pfh-close')) return; // let ✕ through
      e.preventDefault();
      const r = win.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = r.left; startTop = r.top;
      header.setPointerCapture(e.pointerId);
      header.classList.add('dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  updateTabChip(id: string) {
    // Lit = shown (float OR dock); off = hidden. Uniform for tabs and panels.
    this._chips[`tab-${id}`]?.classList.toggle('active', this.getTabMode(id) !== 'hidden');
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
        const tabMode = parsed.tabMode || {};
        const hidden = parsed.hidden || {};
        // One-time migration for layouts saved before the unified float VIEW bar.
        // New defaults: SETTINGS + ARP/EASE/PHASE/GLYPH + EFFECTS start hidden;
        // only VCO/DRAWING stay docked-on. Only fill gaps the user hasn't set.
        const needsMigration = (parsed.v || 0) < LAYOUT_VERSION;
        if (needsMigration) {
          DEFAULT_HIDDEN_UNITS.forEach(id => {
            if (tabMode[id] === undefined) tabMode[id] = 'hidden';
          });
          hidden['panel-synth'] = true; // SETTINGS off by default
        }
        const result: LayoutData = {
          sizes: parsed.sizes || {},
          order: parsed.order || {},
          hidden,
          collapsed: parsed.collapsed || {},
          settingsFloat: needsMigration ? true : !!parsed.settingsFloat,
          settingsFloatPos: parsed.settingsFloatPos || null,
          tabMode,
          tabFloatPos: parsed.tabFloatPos || {},
          v: LAYOUT_VERSION,
        };
        // Persist the migration so it's applied exactly once.
        if (needsMigration) {
          try { localStorage.setItem(this.storageKey, JSON.stringify(result)); } catch (e) {}
        }
        return result;
      }
    } catch (e) {}
    // Fresh install: SETTINGS + ARP/EASE/PHASE/GLYPH + EFFECTS start hidden;
    // VCO/DRAWING docked-on. (settingsFloat=true → shows as float once toggled on.)
    const tabMode: Record<string, string> = {};
    DEFAULT_HIDDEN_UNITS.forEach(id => { tabMode[id] = 'hidden'; });
    return {
      sizes: {}, order: {}, hidden: { 'panel-synth': true }, collapsed: {},
      settingsFloat: true, settingsFloatPos: null,
      tabMode, tabFloatPos: {}, v: LAYOUT_VERSION,
    };
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
    this._groups[containerId] = group;
    this.renderGroup(group);
    this.makeReorderable(group);
  }

  // Rebuilds the container's children as: panel, handle, panel, handle, panel
  // so resize handles always sit between the *current* slot order. Panels that
  // are currently floating are skipped — they live in their float window, and
  // re-appending them here would silently yank them back into the grid.
  renderGroup(group: PanelGroup) {
    const { container, order } = group;
    container.querySelectorAll(':scope > .panel-resize-handle').forEach((h) => h.remove());

    const panels = order
      .filter((id) => this.getTabMode(id) !== 'float')
      .map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
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
        else if (group.containerId === 'panel-bottom') this.applyBottomVisibility();
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

    // SETTINGS chip — uses the settings-float mechanism, not the move-into-window
    // path, but presents the same: ON = shown (floating), OFF = hidden.
    const sChip = document.createElement('button');
    sChip.className = 'panel-toggle-chip panel-toggle-chip-float';
    sChip.textContent = 'SETTINGS';
    sChip.title = 'SETTINGS 表示 / 非表示（右クリックでフロート/ドック/非表示）';
    sChip.addEventListener('click', () =>
      this.setSettingsMode(this._settingsShown() ? 'hidden' : 'float'));
    sChip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, this.settingsMenu());
    });
    this._chips['tab-panel-synth'] = sChip;
    bar.appendChild(sChip);

    // One float chip per floatable unit (tabs + panels). Left-click toggles
    // SHOWN ↔ hidden (shown = float, except VCO/DRAWING which show docked);
    // right-click opens the full フロート / ドック / 非表示 menu.
    const addFloatChip = (id: string, text: string) => {
      const chip = document.createElement('button');
      chip.className = 'panel-toggle-chip panel-toggle-chip-float';
      chip.textContent = text;
      chip.title = `${text} 表示 / 非表示（右クリックでフロート/ドック/非表示）`;
      chip.addEventListener('click', () =>
        this.setTabMode(id, this.getTabMode(id) === 'hidden' ? shownMode(id) : 'hidden'));
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't also trigger the document-level menu handler
        showMenu(e.clientX, e.clientY, this.tabModeMenu(id));
      });
      this._chips[`tab-${id}`] = chip;
      bar.appendChild(chip);
    };
    FLOATABLE_TABS.forEach(({ id, label: text }) => addFloatChip(id, text));
    FLOATABLE_PANELS.forEach(({ id, label: text }) => addFloatChip(id, text));

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
    const floatSettings = !!this.layout.settingsFloat;

    // 1) Panels. panel-synth in float mode is shown as a fixed overlay (CSS),
    //    so it stays out of the grid flow — it's treated as grid-absent below.
    //    A panel floated via the new window mechanism (EFFECTS) is moved OUT of
    //    #synth-main entirely, so it's naturally absent from main.children below.
    TOGGLEABLE_PANELS.forEach(({ id }) => {
      const el = document.getElementById(id);
      // Don't fight the float window for a panel that's been popped out.
      if (el && el.parentElement === main) el.style.display = hidden[id] ? 'none' : '';
    });

    // A panel counts as "in the grid" only if it's actually a child of the row,
    // visible, and not the floating SETTINGS overlay.
    const inGrid = (el?: HTMLElement) =>
      !!el && el.parentElement === main && el.style.display !== 'none'
      && !(floatSettings && el.id === 'panel-synth');

    // 2) Resize handles: a handle is only meaningful between two in-grid panels.
    const children = Array.from(main.children) as HTMLElement[];
    children.forEach((child, i) => {
      if (!child.classList.contains('panel-resize-handle')) return;
      child.style.display = (inGrid(children[i - 1]) && inGrid(children[i + 1])) ? '' : 'none';
    });

    // 3) Rebuild the grid template from the in-grid children, so hidden/floating
    //    panels don't leave empty columns.
    const track = (el: HTMLElement) => {
      if (el.classList.contains('panel-resize-handle')) return '10px';
      if (el.id === 'panel-synth') return 'var(--col-left, 260px)';
      if (el.id === 'panel-effects') return 'var(--col-right, 280px)';
      return 'minmax(0, 1fr)'; // panel-center (or any flexible panel)
    };
    const gridChildren = children.filter(c =>
      c.classList.contains('panel-resize-handle') ? c.style.display !== 'none' : inGrid(c));
    main.style.gridTemplateColumns = gridChildren.map(track).join(' ');

    // 4) Collapse the top row entirely when no panel occupies the grid (count any
    //    in-grid panel — incl. panel-center, which no longer has a VIEW chip).
    const anyInGrid = children.some(c =>
      !c.classList.contains('panel-resize-handle') && inGrid(c));
    document.body.classList.toggle('top-collapsed', !anyInGrid);

    // 5) Sync chip highlight (active = panel visible).
    TOGGLEABLE_PANELS.forEach(({ id }) => {
      this._chips[id]?.classList.toggle('active', !hidden[id]);
    });

    // 6) Panels that were resized/re-shown may need a redraw (canvas re-measure).
    this._pokeRelayout();
  }

  // Nudge canvas-backed editors to re-measure after a layout change. The sync
  // event covers observers that read immediately; the rAF passes catch those
  // that need the browser to have actually laid out the new size first (e.g. a
  // panel/tab just moved into a float window).
  _pokeRelayout() {
    window.dispatchEvent(new Event('resize'));
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }

}

export const panelLayout = new PanelLayout();
