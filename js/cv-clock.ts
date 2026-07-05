/**
 * DLOSy20 - MIDI Clock Sync
 * Synchronize step sequencer to external MIDI Clock (0xF8 @ 24 PPQN).
 * When enabled, Play/Stop is driven by MIDI Start/Stop messages,
 * and step advancement is driven by MIDI timing clock pulses.
 */
import { audioEngine } from './audio-engine';
import { uiComponents } from './ui-components';
import { transportClock } from './transport-clock';
import { vcoLoop } from './vco-loop';

class MidiClockSync {
  enabled: boolean;
  midiAccess: MIDIAccess | null;
  midiInput: MIDIInput | null;
  clockCount: number;
  clocksPerStep: number;
  clockTimes: number[];
  maxClockSamples: number;
  detectedBPM: number;
  rateMultiplier: number;

  constructor() {
    this.enabled = false;
    this.midiAccess = null;
    this.midiInput = null;

    // MIDI Clock: 24 PPQN → 6 clocks per sixteenth note
    this.clockCount = 0;
    this.clocksPerStep = 6;

    // BPM detection from clock intervals
    this.clockTimes = [];
    this.maxClockSamples = 24; // 1 beat worth of clocks for averaging
    this.detectedBPM = 0;
    
    // Rate Multiplier (x0.5, x1, x2)
    this.rateMultiplier = 1;
  }

  async init() {
    this.buildUI();
  }

  // ===== MIDI ACCESS =====

  async connectMIDI() {
    if (!navigator.requestMIDIAccess) {
      this.updateStatus('MIDI N/A');
      this.updateDiag('❌ Web MIDI API is not supported in this browser.\nChrome/Edge only.');
      return;
    }

    this.updateDiag('Requesting MIDI access...');

    try {
      // Try with sysex:true first (needed on some Chrome builds for full device visibility)
      try {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        this.updateDiag('✅ Permission granted (sysex:true)');
      } catch (sysexErr) {
        // Fallback without sysex
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        this.updateDiag('✅ Permission granted (sysex:false)');
      }
    } catch (e) {
      this.updateStatus('Denied');
      this.updateDiag('❌ MIDI Access DENIED.\n\nFix: Chrome アドレスバー左の🔒→サイトの設定\n→MIDIを「許可」に変更してページ再読込');
      console.error('MIDI CLK: requestMIDIAccess failed:', e);
      return;
    }

    this.populateInputs();

    // Use addEventListener so other modules' handlers are not overwritten
    this.midiAccess.addEventListener('statechange', (e: MIDIConnectionEvent) => {
      console.log('MIDI CLK statechange:', e.port?.name, e.port?.state);
      this.populateInputs();
    });

    const count = this.midiAccess.inputs.size;
    console.log('MIDI CLK: inputs found =', count);
    this.midiAccess.inputs.forEach(p => console.log('  -', p.name, p.state));
  }

  attachInput(deviceId: string) {
    // Detach previous
    if (this.midiInput) {
      this.midiInput.onmidimessage = null;
      this.midiInput = null;
    }
    if (!this.midiAccess || !deviceId) return;

    this.midiInput = this.midiAccess.inputs.get(deviceId) ?? null;
    if (this.midiInput) {
      this.midiInput.onmidimessage = (e: MIDIMessageEvent) => this.onMessage(e);
      this.updateStatus('Ready');
    }
  }

  // ===== MIDI CLOCK MESSAGE HANDLING =====

  onMessage(e: MIDIMessageEvent) {
    if (!this.enabled) return;
    const status = e.data![0];

    switch (status) {
      case 0xF8: // Timing Clock (24 PPQN)
        this.onTimingClock();
        break;

      case 0xFA: // Start
        this.clockCount = 0;
        this.clockTimes = [];
        // Start the transport from the beginning
        if (transportClock) {
          transportClock.currentStep = 0;
          transportClock.isPlaying = true;
          const playBtn = document.getElementById('btn-play');
          if (playBtn) {
            playBtn.classList.add('playing');
            const icon = playBtn.querySelector('.play-icon');
            if (icon) icon.textContent = '■';
          }
          if (vcoLoop) vcoLoop.onPlayStart();
          transportClock._stopLookahead(); // disable internal scheduler
        }
        this.updateStatus('▶ Synced');
        break;

      case 0xFB: // Continue
        if (transportClock) {
          transportClock.isPlaying = true;
          transportClock._stopLookahead();
        }
        this.updateStatus('▶ Synced');
        break;

      case 0xFC: // Stop
        if (transportClock) {
          transportClock.isPlaying = false;
          transportClock._stopLookahead();
          const playBtn = document.getElementById('btn-play');
          if (playBtn) {
            playBtn.classList.remove('playing');
            const icon = playBtn.querySelector('.play-icon');
            if (icon) icon.textContent = '▶';
          }
          if (vcoLoop) vcoLoop.onPlayStop();
        }
        this.updateStatus('■ Stopped');
        break;
    }
  }

  onTimingClock() {
    // BPM detection from clock intervals
    const now = performance.now();
    this.clockTimes.push(now);
    if (this.clockTimes.length > this.maxClockSamples) {
      this.clockTimes.shift();
    }

    // Calculate BPM: 24 clocks = 1 beat
    if (this.clockTimes.length >= 2) {
      let total = 0;
      for (let i = 1; i < this.clockTimes.length; i++) {
        total += this.clockTimes[i] - this.clockTimes[i - 1];
      }
      const avgClockMs = total / (this.clockTimes.length - 1);
      // 1 beat = 24 clocks → BPM = 60000 / (avgClockMs * 24)
      const baseBPM = 60000 / (avgClockMs * 24);
      this.detectedBPM = Math.round(baseBPM * this.rateMultiplier);
      this.updateBPMDisplay();
    }

    // Step advancement: every 6 clocks = 1 sixteenth note
    this.clockCount++;
    if (this.clockCount >= this.clocksPerStep) {
      this.clockCount = 0;
      // externalTick fires the current step (Drawing + VCO Loop) then advances.
      if (transportClock) transportClock.externalTick();
    }
  }

  // ===== ENABLE / DISABLE =====

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) {
      if (!this.midiAccess) {
        this.connectMIDI();
      } else {
        // Already have access — re-scan in case new devices appeared
        this.populateInputs();
      }
      this.updateStatus('Waiting...');
    } else {
      this.updateStatus('Off');
    }
    document.getElementById('midi-clk-toggle')?.classList.toggle('midi-active', on);
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('cv-clock-panel');
    if (!container) return;

    container.innerHTML = `
      <div class="cv-clock-controls">
        <div class="cv-clock-row">
          <span class="cv-label">SYNC</span>
          <button id="midi-clk-toggle" class="small-btn">MIDI CLK</button>
          <select id="midi-clk-input-select" class="midi-select">
            <option value="">-- MIDI Input --</option>
          </select>
          <button id="midi-clk-refresh" class="small-btn" title="Refresh / Re-scan MIDI devices">⟳</button>
        </div>
        <div class="cv-clock-row">
          <span class="cv-label">RATE</span>
          <button id="midi-clk-rate-half" class="small-btn rate-btn" data-mult="0.5">x1/2</button>
          <button id="midi-clk-rate-1" class="small-btn rate-btn active" data-mult="1">x1</button>
          <button id="midi-clk-rate-2" class="small-btn rate-btn" data-mult="2">x2</button>
        </div>
        <div class="cv-clock-row">
          <span class="cv-label">BPM</span>
          <span id="midi-clk-bpm" class="cv-val cv-bpm">---</span>
          <span id="midi-clk-status" class="cv-status">Off</span>
        </div>
        <div id="midi-clk-diag" class="cv-clock-diag"></div>
      </div>
    `;

    // Refresh button — always re-request MIDI access to pick up new devices
    document.getElementById('midi-clk-refresh')?.addEventListener('click', async () => {
      const btn = document.getElementById('midi-clk-refresh') as HTMLButtonElement | null;
      if (btn) { btn.textContent = '…'; btn.disabled = true; }
      this.midiAccess = null; // force fresh request
      await this.connectMIDI();
      if (btn) { btn.textContent = '⟳'; btn.disabled = false; }
    });

    // Toggle
    document.getElementById('midi-clk-toggle')?.addEventListener('click', () => {
      this.setEnabled(!this.enabled);
    });

    // Input device select
    document.getElementById('midi-clk-input-select')?.addEventListener('change', (e) => {
      this.attachInput((e.target as HTMLSelectElement).value);
    });

    // Rate Multiplier buttons
    container.querySelectorAll<HTMLElement>('.rate-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mult = parseFloat((e.target as HTMLElement).dataset.mult ?? "");
        this.setRateMultiplier(mult);
      });
    });
  }

  setRateMultiplier(mult: number) {
    this.rateMultiplier = mult;
    this.clocksPerStep = Math.round(6 / mult);

    // Update active class on buttons
    document.querySelectorAll<HTMLElement>('.rate-btn').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.mult ?? "") === mult);
    });
    
    // Recalculate BPM with new multiplier if we have clock data
    if (this.clockTimes.length >= 2) {
      let total = 0;
      for (let i = 1; i < this.clockTimes.length; i++) {
        total += this.clockTimes[i] - this.clockTimes[i - 1];
      }
      const avgClockMs = total / (this.clockTimes.length - 1);
      const baseBPM = 60000 / (avgClockMs * 24);
      this.detectedBPM = Math.round(baseBPM * this.rateMultiplier);
      this.updateBPMDisplay();
    }
  }

  populateInputs() {
    const select = document.getElementById('midi-clk-input-select') as HTMLSelectElement | null;
    if (!select || !this.midiAccess) return;

    const prevVal = select.value;
    select.innerHTML = '<option value="">-- MIDI Input --</option>';
    this.midiAccess.inputs.forEach(input => {
      const opt = document.createElement('option');
      opt.value = input.id;
      opt.textContent = `${input.name} [${input.state}]`;
      select.appendChild(opt);
    });

    const count = this.midiAccess.inputs.size;
    if (count === 0) {
      this.updateStatus('No MIDI inputs');
      // Build diag string listing all raw info
      let diagLines = ['Inputs: 0 — no MIDI ports found.'];
      diagLines.push('');
      diagLines.push('❗ loopMIDIポートは作成済みですか？');
      diagLines.push('(loopMIDI → Port Name 入力 → + ボタン)');
      diagLines.push('');
      diagLines.push('❗ Chrome MIDI許可を確認:');
      diagLines.push('アドレスバー左の🔒アイコン');
      diagLines.push('→ [MIDI] → [許可]');
      diagLines.push('→ ページを再読込み');
      this.updateDiag(diagLines.join('\n'));
    } else {
      this.updateStatus(`${count} port${count > 1 ? 's' : ''} found`);
      let diagLines = [`Inputs: ${count}`];
      this.midiAccess.inputs.forEach(p => {
        diagLines.push(`• ${p.name} [${p.state}] id:${p.id.slice(0,8)}`);
      });
      this.updateDiag(diagLines.join('\n'));
      // Restore previous selection
      if (prevVal && select.querySelector(`option[value="${prevVal}"]`)) {
        select.value = prevVal;
      } else if (!this.midiInput) {
        // Auto-select first
        const first = this.midiAccess.inputs.values().next().value;
        if (first) {
          this.attachInput(first.id);
          select.value = first.id;
        }
      }
    }
  }

  updateBPMDisplay() {
    const el = document.getElementById('midi-clk-bpm');
    if (el) el.textContent = this.detectedBPM ? String(this.detectedBPM) : '---';

    // Also update the main tempo display / knob if synced
    if (this.enabled && this.detectedBPM > 0 && audioEngine) {
      audioEngine.params.tempo = this.detectedBPM;
      // Update knob UI
      const tempoKnob = document.getElementById('knob-tempo');
      if (tempoKnob) {
        tempoKnob.dataset.value = String(this.detectedBPM);
        // Re-render the tempo knob via UIComponents' real API.
        // (旧コードは存在しない renderKnob を呼んでおり、ガードで握り潰されて
        //  ノブが更新されないバグだった。型厳密化で検出 → 正しい API に修正)
        const knob = uiComponents && uiComponents.knobs.tempo;
        if (knob) {
          knob.value = this.detectedBPM;
          uiComponents.updateKnobVisual(knob.el, knob.min, knob.max, this.detectedBPM);
        }
      }
      // Update header BPM display
      const tempoVal = document.getElementById('tempo-value');
      if (tempoVal) tempoVal.textContent = String(this.detectedBPM);
    }
  }

  updateStatus(text: string) {
    const el = document.getElementById('midi-clk-status');
    if (el) el.textContent = text;
  }

  updateDiag(text: string) {
    const el = document.getElementById('midi-clk-diag');
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }
}

export const cvClock = new MidiClockSync();
