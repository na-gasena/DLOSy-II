/**
 * DLOSy20 - Settings
 * App settings modal (gear icon): audio output device / sample rate / latency /
 * limiter, plus layout utilities (panel-layout reset).
 */
import { audioEngine } from './audio-engine';
import { panelLayout } from './panel-layout';

// Selectable color themes (CSS variable sets in main.css, keyed by
// body[data-theme]). '' = the default dark theme defined on :root.
const THEMES: { id: string; label: string }[] = [
  { id: '', label: 'Dark（標準）' },
  { id: 'light', label: 'Light' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'crt', label: 'CRT' },
];

class AudioSettings {
  isOpen: boolean;
  currentSinkId: string;
  savedSettings: any | null;
  theme: string = 'crt'; // default theme for a fresh install (no saved settings yet)
  _limiter: DynamicsCompressorNode | null = null;

  constructor() {
    this.isOpen = false;
    this.currentSinkId = '';
    this.savedSettings = null;
  }

  async init() {
    this.loadSettings();
    this.applyTheme(this.theme); // restore saved theme before first paint settles
    this.buildToggleButton();
    this.buildModal();
  }

  // ===== COLOR THEME =====

  applyTheme(id: string) {
    this.theme = THEMES.some(t => t.id === id) ? id : '';
    if (this.theme) {
      document.body.dataset.theme = this.theme;
    } else {
      delete document.body.dataset.theme;
    }
  }

  // Public: apply + persist + reflect in the Settings <select> (used by the
  // command palette and any external caller).
  setTheme(id: string) {
    this.applyTheme(id);
    this.saveSettings();
    const sel = document.getElementById('as-theme') as HTMLSelectElement | null;
    if (sel) sel.value = this.theme;
  }

  // ===== PERSISTENT SETTINGS =====

  loadSettings() {
    try {
      const raw = localStorage.getItem('dlosy20_audio_settings');
      if (raw) {
        this.savedSettings = JSON.parse(raw);
        this.currentSinkId = this.savedSettings.sinkId || '';
        // Preserve an explicit theme choice (including '' = Dark) by checking
        // key presence rather than truthiness — otherwise an explicit "Dark"
        // pick would be indistinguishable from "never chosen" and silently
        // revert to the CRT default on reload.
        if ('theme' in this.savedSettings) this.theme = this.savedSettings.theme || '';
      }
    } catch (e) {}
  }

  saveSettings() {
    const settings = {
      sinkId: this.currentSinkId,
      latencyHint: (document.getElementById('as-latency') as HTMLSelectElement | null)?.value || 'interactive',
      sampleRate: (document.getElementById('as-samplerate-select') as HTMLSelectElement | null)?.value || '48000',
      theme: this.theme,
    };
    localStorage.setItem('dlosy20_audio_settings', JSON.stringify(settings));
  }

  // ===== UI =====

  buildToggleButton() {
    const header = document.querySelector('.header-controls');
    if (!header) return;
    const btn = document.createElement('button');
    btn.id = 'btn-audio-settings';
    btn.className = 'transport-btn';
    btn.textContent = '⚙';
    btn.title = 'Settings';
    btn.addEventListener('click', () => this.toggle());
    header.appendChild(btn);
  }

  buildModal() {
    const modal = document.createElement('div');
    modal.id = 'audio-settings-modal';
    modal.className = 'as-modal';
    modal.innerHTML = `
      <div class="as-backdrop"></div>
      <div class="as-panel">
        <div class="as-title">SETTINGS <button id="as-close" class="small-btn">✕</button></div>

        <div class="as-section-title">AUDIO</div>

        <div class="as-row">
          <span class="as-label">Output Device</span>
          <select id="as-output-device" class="midi-select as-select"></select>
        </div>

        <div class="as-row">
          <span class="as-label">Latency Mode</span>
          <select id="as-latency" class="midi-select as-select">
            <option value="interactive">Interactive (低レイテンシ)</option>
            <option value="balanced">Balanced</option>
            <option value="playback">Playback (安定)</option>
          </select>
        </div>

        <div class="as-row">
          <span class="as-label">Sample Rate</span>
          <select id="as-samplerate-select" class="midi-select as-select">
            <option value="0">OS Default</option>
            <option value="44100">44,100 Hz (44.1 kHz)</option>
            <option value="48000" selected>48,000 Hz (48 kHz)</option>
            <option value="96000">96,000 Hz (96 kHz)</option>
          </select>
        </div>

        <div class="as-row">
          <span class="as-label">Actual Rate</span>
          <span id="as-samplerate" class="as-val">--</span>
        </div>

        <div class="as-row">
          <span class="as-label">Buffer Size</span>
          <span id="as-buffersize" class="as-val">--</span>
        </div>

        <div class="as-row">
          <span class="as-label">Channel Count</span>
          <span id="as-channels" class="as-val">--</span>
        </div>

        <div class="as-row">
          <span class="as-label">Limiter</span>
          <button id="as-limiter-toggle" class="small-btn">OFF</button>
        </div>

        <div class="as-section-title">DISPLAY</div>

        <div class="as-row">
          <span class="as-label">Theme</span>
          <select id="as-theme" class="midi-select as-select">
            ${THEMES.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
          </select>
        </div>

        <div class="as-row">
          <span class="as-label">Settings Panel</span>
          <select id="as-settings-float" class="midi-select as-select">
            <option value="dock">Docked（ドッキング）</option>
            <option value="float">Floating（フロート）</option>
          </select>
        </div>

        <div class="as-row">
          <span class="as-label">Panel Layout</span>
          <button id="as-reset-layout" class="small-btn as-wide-btn" title="パネルのサイズ・配置・表示状態を初期化">RESET</button>
        </div>

        <div class="as-note">
          ※ ASIO利用はOS側でFlexASIO等を設定してください。<br>
          ※ Sample Rate変更にはAudioContext再構築が必要です。
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Events
    modal.querySelector('.as-backdrop')?.addEventListener('click', () => this.toggle());
    document.getElementById('as-close')?.addEventListener('click', () => this.toggle());

    // Layout reset (moved here from the old header ⟲ button)
    document.getElementById('as-reset-layout')?.addEventListener('click', () => {
      if (confirm('パネルのサイズ・配置をリセットしますか？')) {
        panelLayout.resetLayout();
      }
    });

    // Color theme
    const themeSel = document.getElementById('as-theme') as HTMLSelectElement | null;
    if (themeSel) {
      themeSel.value = this.theme;
      themeSel.addEventListener('change', () => {
        this.applyTheme(themeSel.value);
        this.saveSettings();
      });
    }

    // Settings-panel float / dock mode (handled by panel-layout)
    const floatSel = document.getElementById('as-settings-float') as HTMLSelectElement | null;
    if (floatSel) {
      floatSel.value = (panelLayout as any).layout?.settingsFloat ? 'float' : 'dock';
      floatSel.addEventListener('change', () => {
        panelLayout.setSettingsFloat(floatSel.value === 'float');
      });
    }

    document.getElementById('as-output-device')?.addEventListener('change', (e) => {
      this.setOutputDevice((e.target as HTMLSelectElement).value);
    });

    // Latency mode change → rebuild AudioContext with new latencyHint
    // (a larger buffer / 'playback' mode is the main lever against dropouts).
    document.getElementById('as-latency')?.addEventListener('change', async (e) => {
      const sel = e.target as HTMLSelectElement;
      const hint = sel.value || 'interactive';
      sel.disabled = true;
      const srEl = document.getElementById('as-samplerate');
      if (srEl) srEl.textContent = '再構築中...';

      if (audioEngine) {
        audioEngine.latencyHint = hint as AudioContextLatencyCategory;
        if (audioEngine.isInitialized) {
          await audioEngine.reinit(audioEngine.sampleRate);
          await this.applySinkId();
        }
      }

      this.saveSettings();
      await this.refreshInfo();
      sel.disabled = false;
    });

    // Sample rate change → reinit AudioContext
    document.getElementById('as-samplerate-select')?.addEventListener('change', async (e) => {
      const btn = e.target as HTMLSelectElement;
      const srVal = parseInt(btn.value, 10);
      btn.disabled = true;

      // Show rebuilding state in Actual Rate
      const srEl = document.getElementById('as-samplerate');
      if (srEl) srEl.textContent = '再構築中...';

      if (audioEngine && audioEngine.isInitialized) {
        await audioEngine.reinit(srVal || null);
        await this.applySinkId();
      } else {
        // Not yet initialized — just update the stored value
        if (audioEngine) audioEngine.sampleRate = srVal || 48000;
      }

      this.saveSettings();
      await this.refreshInfo();
      btn.disabled = false;
    });

    document.getElementById('as-limiter-toggle')?.addEventListener('click', () => {
      this.toggleLimiter();
    });
  }

  toggle() {
    this.isOpen = !this.isOpen;
    const modal = document.getElementById('audio-settings-modal');
    if (modal) {
      modal.classList.toggle('open', this.isOpen);
      if (this.isOpen) this.refreshInfo();
    }
  }

  async refreshInfo() {
    // Populate output devices
    await this.populateOutputDevices();

    // Restore saved sample rate selection
    const saved = this.savedSettings;
    if (saved?.sampleRate) {
      const sel = document.getElementById('as-samplerate-select') as HTMLSelectElement | null;
      if (sel) sel.value = saved.sampleRate;
    }
    // Restore saved latency mode selection
    if (saved?.latencyHint) {
      const latSel = document.getElementById('as-latency') as HTMLSelectElement | null;
      if (latSel) latSel.value = saved.latencyHint;
    }

    // Show current audio context info
    if (audioEngine && audioEngine.ctx) {
      const ctx = audioEngine.ctx!;
      const srEl = document.getElementById('as-samplerate');
      const bsEl = document.getElementById('as-buffersize');
      const chEl = document.getElementById('as-channels');
      if (srEl) srEl.textContent = ctx.sampleRate.toLocaleString() + ' Hz';
      if (bsEl) bsEl.textContent = ctx.baseLatency ? Math.round(ctx.baseLatency * ctx.sampleRate) + ' samples' : 'N/A';
      if (chEl) chEl.textContent = String(ctx.destination.channelCount);
    }
  }

  async populateOutputDevices() {
    const select = document.getElementById('as-output-device') as HTMLSelectElement | null;
    if (!select) return;

    try {
      // Request permission first
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      select.innerHTML = '<option value="">-- Default --</option>';
      outputs.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Output ${dev.deviceId.slice(0, 8)}`;
        if (dev.deviceId === this.currentSinkId) opt.selected = true;
        select.appendChild(opt);
      });
    } catch (e) {
      select.innerHTML = '<option value="">Permission denied</option>';
    }
  }

  async setOutputDevice(deviceId: string) {
    this.currentSinkId = deviceId;
    await this.applySinkId();
    this.saveSettings();
  }

  // (Re-)apply this.currentSinkId to whichever AudioContext currently exists.
  // Must be called whenever a new AudioContext is created (initial init,
  // or reinit() after a sample-rate change) since setSinkId is per-context
  // and a freshly created context always starts on the OS default device.
  async applySinkId() {
    if (!this.currentSinkId) return;
    if (!audioEngine || !audioEngine.ctx || !audioEngine.ctx!.destination) return;
    try {
      // setSinkId on AudioContext は新しめの API で lib.dom にまだ無いため any 経由で呼ぶ
      const ctx = audioEngine.ctx as any;
      if (typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(this.currentSinkId);
      }
    } catch (e) {
      console.warn('setSinkId not supported / failed:', e);
    }
  }

  toggleLimiter() {
    const btn = document.getElementById('as-limiter-toggle');
    if (!audioEngine || !audioEngine.ctx) return;

    if (this._limiter) {
      // Remove limiter
      try {
        this._limiter.disconnect();
        audioEngine.masterGain!.disconnect();
        audioEngine.masterGain!.connect(audioEngine.ctx!.destination);
      } catch(e) {}
      this._limiter = null;
      if (btn) { btn.textContent = 'OFF'; btn.classList.remove('midi-active'); }
    } else {
      // Insert limiter (DynamicsCompressor)
      const ctx = audioEngine.ctx!;
      this._limiter = ctx.createDynamicsCompressor();
      this._limiter.threshold.value = -6;
      this._limiter.knee.value = 12;
      this._limiter.ratio.value = 20;
      this._limiter.attack.value = 0.003;
      this._limiter.release.value = 0.05;

      try {
        audioEngine.masterGain!.disconnect();
        audioEngine.masterGain!.connect(this._limiter);
        this._limiter.connect(ctx.destination);
      } catch(e) {}
      if (btn) { btn.textContent = 'ON'; btn.classList.add('midi-active'); }
    }
  }
}

export const audioSettings = new AudioSettings();
