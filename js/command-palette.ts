/**
 * DLOSy20 - Command Palette (Ctrl/Cmd + K)
 *
 * A single search box that fuzzy-matches a flat list of commands and runs the
 * chosen one. Commands are contributed at registration time (each module owns
 * its own) so this file stays generic. Keyboard-only, minimal footprint —
 * appears on demand, vanishes on Esc / blur (Tweeq principle 3).
 */

export interface Command {
  id: string;
  title: string;
  hint?: string;         // right-aligned hint (shortcut / category)
  run: () => void;
}

const commands: Command[] = [];
let _overlay: HTMLElement | null = null;
let _installed = false;

export function registerCommand(cmd: Command): void {
  const i = commands.findIndex(c => c.id === cmd.id);
  if (i >= 0) commands[i] = cmd; else commands.push(cmd);
}

export function registerCommands(cmds: Command[]): void {
  cmds.forEach(registerCommand);
}

/** Subsequence fuzzy match: returns a score (higher = better) or -1. */
function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0, score = 0, streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += streak;                       // reward consecutive hits
      if (ti === 0 || t[ti - 1] === ' ') score += 5; // reward word-starts
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function initCommandPalette(): void {
  if (_installed) return;
  _installed = true;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  });
}

function toggle() { _overlay ? close() : open(); }

function open() {
  close();
  const overlay = document.createElement('div');
  overlay.className = 'cmdp-overlay';
  overlay.innerHTML = `
    <div class="cmdp-panel" role="dialog" aria-label="Command Palette">
      <input class="cmdp-input" type="text" placeholder="コマンドを検索…  (Esc で閉じる)" />
      <div class="cmdp-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlay = overlay;

  const input = overlay.querySelector('.cmdp-input') as HTMLInputElement;
  const list = overlay.querySelector('.cmdp-list') as HTMLElement;
  let active = 0;
  let filtered: Command[] = [];

  const render = () => {
    const q = input.value.trim();
    filtered = commands
      .map(c => ({ c, s: fuzzy(q, c.title) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(x => x.c);
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
    list.innerHTML = '';
    filtered.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'cmdp-item' + (i === active ? ' active' : '');
      row.innerHTML = `<span class="cmdp-title"></span>${c.hint ? `<span class="cmdp-hint"></span>` : ''}`;
      (row.querySelector('.cmdp-title') as HTMLElement).textContent = c.title;
      if (c.hint) (row.querySelector('.cmdp-hint') as HTMLElement).textContent = c.hint;
      row.addEventListener('mousemove', () => { if (active !== i) { active = i; render(); } });
      row.addEventListener('click', () => runActive(i));
      list.appendChild(row);
    });
  };

  const runActive = (i = active) => {
    const cmd = filtered[i];
    close();
    cmd?.run();
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  render();
  input.focus();
}

function close() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
}
