/**
 * DLOSy20 - MIDI IN
 * Receive MIDI keyboard input and route to synth / drums / arp / parameters.
 * Supports 2 simultaneous MIDI input devices with independent modes and CC maps.
 */
import { audioEngine } from './audio-engine';
import { vcoLoop } from './vco-loop';
import { arpeggiator } from './arpeggiator';

interface CCMapping {
  target: string;
  min: number;
  max: number;
}

type CCMap = Record<number, CCMapping>;

interface MidiBank {
  name: string;
  ccMap: CCMap;
  ccMap2: CCMap;
}

interface CCLearnTarget {
  target: string;
  label: string;
  min: number;
  max: number;
}

class MidiIn {
  enabled: boolean;
  configKey: string;
  reverseLearnDev: string | null;
  reverseCC: number | null;
  _reverseClickHandler: ((e: MouseEvent) => void) | null;
  banks: MidiBank[];
  activeBank: number;
  selectedInput: MIDIInput | null;
  mode: string;
  ccMap: CCMap;
  ccLearnActive: boolean;
  ccLearnTarget: CCMapping | null;
  selectedInput2: MIDIInput | null;
  mode2: string;
  ccMap2: CCMap;
  ccLearnActive2: boolean;
  ccLearnTarget2: CCMapping | null;
  ccLearnTargets: CCLearnTarget[];
  activeNotes: Map<number, { osc: OscillatorNode; gain: GainNode }>;
  midiAccess: MIDIAccess | null = null;
  _pendingDeviceName: string | null = null;
  _pendingDeviceName2: string | null = null;

  constructor() {
    this.enabled = false;

    // Dedicated persistence — controller mapping is a HARDWARE setup concern,
    // kept fully separate from the musical sound-preset blob so loading a
    // preset never clobbers it, and it survives every reload.
    this.configKey = 'dlosy20_midi_config';

    // Reverse-learn state: capture a CC first, then click an on-screen control.
    this.reverseLearnDev = null; // '1' | '2' | null
    this.reverseCC = null;
    this._reverseClickHandler = null;

    // Named mapping snapshots
    this.banks = [];      // [{ name, ccMap, ccMap2 }]
    this.activeBank = -1;

    // ===== Device 1 =====
    this.selectedInput = null;
    this.mode = 'synth'; // 'synth' | 'arp'

    // CC mapping IN1: ccNumber → { target, min, max }
    this.ccMap = {
      1:  { target: 'cutoff',    min: 100,   max: 5000 },
      74: { target: 'resonance', min: 0,     max: 30   },
      71: { target: 'envAttack', min: 0.001, max: 0.5  },
      72: { target: 'envRelease',min: 0.01,  max: 2.0  },
      73: { target: 'envDecay',  min: 0.01,  max: 1.0  },
      7:  { target: 'masterVol', min: 0,     max: 1    },
    };
    this.ccLearnActive = false;
    this.ccLearnTarget = null;

    // ===== Device 2 =====
    this.selectedInput2 = null;
    this.mode2 = 'synth'; // 'synth' | 'arp'

    // CC mapping IN2: independent map
    this.ccMap2 = {};
    this.ccLearnActive2 = false;
    this.ccLearnTarget2 = null;

    // Available CC Learn targets (for UI)
    this.ccLearnTargets = [
      { target: 'cutoff',       label: 'Cutoff',     min: 100,   max: 5000 },
      { target: 'resonance',    label: 'Resonance',  min: 0,     max: 30   },
      { target: 'envAttack',    label: 'Attack',     min: 0.001, max: 0.5  },
      { target: 'envDecay',     label: 'Decay',      min: 0.01,  max: 1.0  },
      { target: 'envRelease',   label: 'Release',    min: 0.01,  max: 2.0  },
      { target: 'masterVol',    label: 'Master Vol', min: 0,     max: 1    },
      { target: 'vcoLoop0',     label: 'VCO L1',     min: 0,     max: 1    },
      { target: 'vcoLoop1',     label: 'VCO L2',     min: 0,     max: 1    },
      { target: 'vcoLoop2',     label: 'VCO L3',     min: 0,     max: 1    },
      { target: 'vcoLoop3',     label: 'VCO L4',     min: 0,     max: 1    },
      { target: 'vcoLoop4',     label: 'VCO L5',     min: 0,     max: 1    },
      { target: 'vcoLoop5',     label: 'VCO L6',     min: 0,     max: 1    },
      { target: 'vcoLoop6',     label: 'VCO L7',     min: 0,     max: 1    },
      { target: 'vcoLoop7',     label: 'VCO L8',     min: 0,     max: 1    },
      { target: 'vcoTabFreq',   label: 'VCO FREQ',   min: 0, max: 1 },
      { target: 'vcoTabCutoff', label: 'VCO CUTOFF', min: 0, max: 1 },
      { target: 'vcoTabRes',    label: 'VCO RES',    min: 0, max: 1 },
      { target: 'vcoTabVol',    label: 'VCO VOL',    min: 0, max: 1 },
      { target: 'vcoTabAdsr',   label: 'VCO ADSR (S)', min: 0, max: 1 },
      { target: 'vcoModeStep',  label: 'VCO STEP',   min: 0, max: 1 },
      { target: 'vcoModeCont',  label: 'VCO CONT',   min: 0, max: 1 },
      { target: 'vcoMasterVol', label: 'VCO MasterVol', min: 0, max: 1 },
      { target: 'arpFreq',      label: 'ARP FREQ',   min: 0, max: 1000 },
      { target: 'arpRatio',     label: 'ARP RATIO',  min: 10, max: 400 },
      { target: 'arpGlitch',    label: 'ARP GLITCH', min: 4, max: 64 },
      { target: 'arpVol',       label: 'ARP VOL',    min: 0, max: 100 },
    ];

    // Active notes (for Note Off tracking)
    this.activeNotes = new Map(); // note => { osc, gain }
  }

  async init() {
    this.buildUI();
    this.loadConfig();     // restore independent MIDI config (or migrate from old preset)
    this.renderMaps();
    this.refreshBankSelect();
    this.syncUIFromState();
    this.connectMIDI();
  }

  // Request MIDI access (standalone — MIDI IN owns its own access now).
  async connectMIDI() {
    if (!navigator.requestMIDIAccess) {
      this.updateStatus('MIDI not supported');
      return;
    }
    let midiAccess = null;
    try {
      midiAccess = await navigator.requestMIDIAccess();
    } catch (e) {
      this.updateStatus('Access denied');
      return;
    }

    this.midiAccess = midiAccess;

    // --- TEMP DIAGNOSTIC (remove after debugging) ---
    console.log('[MIDI IN] requestMIDIAccess OK. inputs =', midiAccess.inputs.size,
                '| enabled =', this.enabled);
    for (const input of midiAccess.inputs.values()) {
      console.log('[MIDI IN]   device:', input.name,
                  '| state:', input.state, '| connection:', input.connection);
    }
    if (midiAccess.inputs.size === 0) {
      console.warn('[MIDI IN] 入力デバイスが1つも見つかりません（未接続 / OS未認識 / 他アプリが占有中の可能性）');
    }
    // ------------------------------------------------

    this.populateInputs();
    midiAccess.onstatechange = () => this.populateInputs();
    this.updateStatus('Ready');
  }

  // ===== MESSAGE HANDLING =====

  handleMessage(e: MIDIMessageEvent) {
    if (!this.enabled) return;
    const [status, data1, data2] = e.data!;
    const msgType = status & 0xF0;

    switch (msgType) {
      case 0x90: // Note On
        if (data2 > 0) {
          this._dispatchNoteOn(data1, data2, this.mode);
          this._triggerIndicator('midi-in-indicator1');
        } else {
          this._dispatchNoteOff(data1, this.mode);
        }
        break;
      case 0x80: // Note Off
        this._dispatchNoteOff(data1, this.mode);
        break;
      case 0xB0: // CC
        this.onCC(data1, data2);
        break;
    }
  }

  handleMessage2(e: MIDIMessageEvent) {
    if (!this.enabled) return;
    const [status, data1, data2] = e.data!;
    const msgType = status & 0xF0;

    switch (msgType) {
      case 0x90: // Note On
        if (data2 > 0) {
          this._dispatchNoteOn(data1, data2, this.mode2);
          this._triggerIndicator('midi-in-indicator2');
        } else {
          this._dispatchNoteOff(data1, this.mode2);
        }
        break;
      case 0x80: // Note Off
        this._dispatchNoteOff(data1, this.mode2);
        break;
      case 0xB0: // CC
        this.onCC2(data1, data2);
        break;
    }
  }

  _triggerIndicator(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 100);
  }

  _dispatchNoteOn(note: number, velocity: number, mode: string) {
    if (mode === 'synth') {
      this.playSynthNote(note, velocity);
    } else if (mode === 'arp') {
      if (arpeggiator && arpeggiator.enabled) arpeggiator.addNote(note);
    }
  }

  _dispatchNoteOff(note: number, mode: string) {
    if (mode === 'synth') {
      this.stopSynthNote(note);
    } else if (mode === 'arp') {
      if (arpeggiator && arpeggiator.enabled) arpeggiator.removeNote(note);
    }
  }

  // Legacy wrappers (kept for internal compatibility)
  onNoteOn(note: number, velocity: number) { this._dispatchNoteOn(note, velocity, this.mode); }
  onNoteOff(note: number)          { this._dispatchNoteOff(note, this.mode); }

  // ===== SYNTH MODE =====

  playSynthNote(midiNote: number, velocity: number) {
    if (!audioEngine || !audioEngine.ctx) return;

    // Convert MIDI note to frequency
    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);

    // Play audio with proper note-on/off tracking.
    // (旧コードは audioEngine.playNote(freq, noteName) を呼んでいたが、playNote は
    //  「ノート名」を取り freq を名前として渡していたため getNoteFreq が失敗して
    //  MIDI synth モードが無音だった。型厳密化で引数型不一致として検出。
    //  note-off を stopSynthNote / activeNotes で扱う playDirectNote が正しい経路)
    this.playDirectNote(freq, midiNote);
  }

  playDirectNote(freq: number, midiNote: number) {
    const ctx = audioEngine.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // 'drawing' は標準オシレーターでは無効な type なので sine にフォールバック
    osc.type = audioEngine.params.waveType === 'drawing' ? 'sine' : (audioEngine.params.waveType || 'sine');
    osc.frequency.value = freq;
    gain.gain.value = 0;

    osc.connect(gain);
    if (audioEngine.filter) {
      gain.connect(audioEngine.filter);
    } else {
      gain.connect(audioEngine.masterGain!);
    }

    osc.start();

    // ADSR attack
    const now = ctx.currentTime;
    const atk = audioEngine.params.envAttack || 0.01;
    const vol = audioEngine.params.synthVol || 0.5;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + atk);

    this.activeNotes.set(midiNote, { osc, gain });
  }

  stopSynthNote(midiNote: number) {
    const active = this.activeNotes.get(midiNote);
    if (!active) return;

    const ctx = audioEngine.ctx!;
    const now = ctx.currentTime;
    const rel = audioEngine.params.envRelease || 0.2;

    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setValueAtTime(active.gain.gain.value, now);
    active.gain.gain.linearRampToValueAtTime(0, now + rel);

    setTimeout(() => {
      try { active.osc.stop(); } catch(e) {}
      try { active.osc.disconnect(); } catch(e) {}
      try { active.gain.disconnect(); } catch(e) {}
    }, rel * 1000 + 50);

    this.activeNotes.delete(midiNote);
  }

  // ===== CC HANDLING (IN1) =====

  onCC(ccNumber: number, value: number) {
    // Reverse Learn IN1: capture the CC, then wait for a control click
    if (this.reverseLearnDev === '1' && this.reverseCC === null) {
      this._captureReverseCC(ccNumber);
      return;
    }
    // CC Learn IN1 (forward)
    if (this.ccLearnActive && this.ccLearnTarget) {
      this.ccMap[ccNumber] = this.ccLearnTarget;
      this.ccLearnActive = false;
      this.ccLearnTarget = null;
      this.updateStatus('CC' + ccNumber + ' → IN1 mapped');
      document.getElementById('midi-in-learn')?.classList.remove('active');
      const learnSelect = document.getElementById('midi-in-learn-target') as HTMLSelectElement | null;
      if (learnSelect) learnSelect.value = '';
      this.renderMaps();
      this.saveConfig();
      return;
    }

    this._applyCC(ccNumber, value, this.ccMap);
  }

  // ===== CC HANDLING (IN2) =====

  onCC2(ccNumber: number, value: number) {
    // Reverse Learn IN2: capture the CC, then wait for a control click
    if (this.reverseLearnDev === '2' && this.reverseCC === null) {
      this._captureReverseCC(ccNumber);
      return;
    }
    // CC Learn IN2 (forward)
    if (this.ccLearnActive2 && this.ccLearnTarget2) {
      this.ccMap2[ccNumber] = this.ccLearnTarget2;
      this.ccLearnActive2 = false;
      this.ccLearnTarget2 = null;
      this.updateStatus('CC' + ccNumber + ' → IN2 mapped');
      document.getElementById('midi-in-learn')?.classList.remove('active');
      const learnSelect = document.getElementById('midi-in-learn-target') as HTMLSelectElement | null;
      if (learnSelect) learnSelect.value = '';
      this.renderMaps();
      this.saveConfig();
      return;
    }

    this._applyCC(ccNumber, value, this.ccMap2);
  }

  _applyCC(ccNumber: number, value: number, map: CCMap) {
    const mapping = map[ccNumber];
    if (!mapping) return;

    const normalized = value / 127;
    const param = mapping.target;

    // VCO LOOP control points (vcoLoop0 - vcoLoop7)
    const vcoMatch = param.match(/^vcoLoop(\d)$/);
    if (vcoMatch && vcoLoop) {
      const sliderIdx = parseInt(vcoMatch[1]);
      vcoLoop.setControlPointFromMidi(sliderIdx, normalized);
      return;
    }

    if (param.startsWith('vco') && vcoLoop) {
      if (value > 63) { // Trigger on high value
        if (param === 'vcoTabFreq') vcoLoop.switchParam('frequency');
        else if (param === 'vcoTabCutoff') vcoLoop.switchParam('cutoff');
        else if (param === 'vcoTabRes') vcoLoop.switchParam('resonance');
        else if (param === 'vcoTabVol') vcoLoop.switchParam('volume');
        else if (param === 'vcoTabAdsr') vcoLoop.switchParam('adsr');
        else if (param === 'vcoModeStep') vcoLoop.setContinuousMode(false);
        else if (param === 'vcoModeCont') vcoLoop.setContinuousMode(true);
      }
      if (param === 'vcoMasterVol') {
        vcoLoop.masterVolume = normalized;
        const slider = document.getElementById('vco-vol-slider') as HTMLInputElement | null;
        if (slider) slider.value = String(Math.round(normalized * 100));
      }
      return;
    }

    if (!audioEngine) return;
    const val = mapping.min + normalized * (mapping.max - mapping.min);

    // Apply to AudioEngine param
    if (param === 'cutoff' && audioEngine.filter) {
      audioEngine.params.cutoff = val;
      audioEngine.filter.frequency.value = val;
    } else if (param === 'resonance' && audioEngine.filter) {
      audioEngine.params.resonance = val;
      audioEngine.filter.Q.value = val;
    } else if (param === 'masterVol' && audioEngine.masterGain) {
      audioEngine.params.masterVol = val;
      audioEngine.masterGain.gain.value = val;
    } else if (param.startsWith('arp') && arpeggiator) {
      const elId = param === 'arpVol' ? 'arp-vol-slider' :
                   param === 'arpFreq' ? 'arp-freq-slider' :
                   param === 'arpRatio' ? 'arp-ratio-slider' :
                   param === 'arpGlitch' ? 'arp-glitch-slider' : '';
      const el = document.getElementById(elId) as HTMLInputElement | null;
      if (el) {
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    } else if ((audioEngine.params as any)[param] !== undefined) {
      (audioEngine.params as any)[param] = val;
    }

    // Update knob UI if exists
    const knob = document.querySelector(`[data-param="${param}"]`) as HTMLInputElement | null;
    if (knob) {
      knob.value = String(val);
      knob.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('midi-in-panel');
    if (!container) return;

    container.innerHTML = `
      <div class="midi-in-controls">
        <div class="midi-in-row">
          <button id="midi-in-toggle" class="small-btn">MIDI IN</button>
          <span id="midi-in-status" class="midi-status">Off</span>
        </div>

        <div class="midi-in-row midi-in-device-row">
          <span class="midi-label">IN1</span>
          <select id="midi-in-select" class="midi-select">
            <option value="">-- No Device --</option>
          </select>
          <button id="midi-in-refresh" class="small-btn" title="Refresh MIDI device list">⟳</button>
        </div>
        <div class="midi-in-row">
          <span class="midi-label">MOD1</span>
          <button id="midi-in-mode-synth" class="small-btn active">SYNTH</button>
          <button id="midi-in-mode-arp" class="small-btn">ARP</button>
          <div id="midi-in-indicator1" class="midi-indicator"></div>
        </div>

        <div class="midi-in-row midi-in-device-row">
          <span class="midi-label">IN2</span>
          <select id="midi-in-select2" class="midi-select">
            <option value="">-- No Device --</option>
          </select>
        </div>
        <div class="midi-in-row">
          <span class="midi-label">MOD2</span>
          <button id="midi-in-mode2-synth" class="small-btn active">SYNTH</button>
          <button id="midi-in-mode2-arp" class="small-btn">ARP</button>
          <div id="midi-in-indicator2" class="midi-indicator"></div>
        </div>

        <!-- ===== CC MAPPING ===== -->
        <div class="midi-map-section">
          <div class="midi-in-row midi-learn-row">
            <select id="midi-in-learn-dev" class="midi-select" title="Learn target device">
              <option value="1">IN1</option>
              <option value="2">IN2</option>
            </select>
            <select id="midi-in-learn-target" class="midi-select" title="CC Learn target">
              <option value="">Target...</option>
            </select>
            <button id="midi-in-learn" class="small-btn" title="Pick a target, then move a CC">LEARN</button>
          </div>
          <div class="midi-in-row midi-learn-row">
            <button id="midi-in-rlearn" class="small-btn midi-rlearn-btn" title="Move a CC, then click any on-screen control">⤵ REVERSE LEARN</button>
          </div>

          <div id="midi-map-table1" class="midi-map-table"></div>
          <div id="midi-map-table2" class="midi-map-table"></div>
        </div>

        <!-- ===== BANKS / IMPORT-EXPORT ===== -->
        <div class="midi-bank-section">
          <div class="midi-in-row midi-bank-row">
            <select id="midi-bank-select" class="midi-select" title="Mapping bank"></select>
            <button id="midi-bank-save" class="small-btn" title="Save current mapping as a bank">＋BANK</button>
            <button id="midi-bank-del" class="small-btn" title="Delete selected bank">DEL</button>
          </div>
          <div class="midi-in-row midi-bank-row">
            <button id="midi-cfg-export" class="small-btn" title="Export MIDI config to file">EXPORT</button>
            <button id="midi-cfg-import" class="small-btn" title="Import MIDI config from file">IMPORT</button>
          </div>
        </div>
      </div>
    `;

    // Populate CC Learn target select
    const learnSelect = document.getElementById('midi-in-learn-target');
    if (learnSelect) {
      this.ccLearnTargets.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.target;
        opt.textContent = t.label;
        learnSelect.appendChild(opt);
      });
    }

    // Toggle
    document.getElementById('midi-in-toggle')?.addEventListener('click', () => {
      this.enabled = !this.enabled;
      document.getElementById('midi-in-toggle')?.classList.toggle('midi-active', this.enabled);
      this.updateStatus(this.enabled ? 'ON' : 'Off');
      if (this.enabled) {
        if (!this.midiAccess) {
          this.connectMIDI();
        } else {
          this.populateInputs();
        }
      }
      this.saveConfig();
    });

    // Refresh button — re-scan MIDI devices
    document.getElementById('midi-in-refresh')?.addEventListener('click', async () => {
      const btn = document.getElementById('midi-in-refresh');
      if (btn) btn.textContent = '…';
      if (!this.midiAccess) {
        await this.connectMIDI();
      } else {
        this.populateInputs();
      }
      if (btn) btn.textContent = '⟳';
    });

    // Input device 1 select
    document.getElementById('midi-in-select')?.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (this.selectedInput) {
        this.selectedInput.onmidimessage = null;
      }
      if (this.midiAccess && id) {
        this.selectedInput = this.midiAccess.inputs.get(id) ?? null;
        if (this.selectedInput) {
          this.selectedInput.onmidimessage = (ev) => this.handleMessage(ev);
        }
      } else {
        this.selectedInput = null;
      }
      this.saveConfig();
    });

    // Input device 2 select
    document.getElementById('midi-in-select2')?.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (this.selectedInput2) {
        this.selectedInput2.onmidimessage = null;
      }
      if (this.midiAccess && id) {
        this.selectedInput2 = this.midiAccess.inputs.get(id) ?? null;
        if (this.selectedInput2) {
          this.selectedInput2.onmidimessage = (ev) => this.handleMessage2(ev);
        }
      } else {
        this.selectedInput2 = null;
      }
      this.saveConfig();
    });

    // Mode buttons IN1
    document.getElementById('midi-in-mode-synth')?.addEventListener('click', () => this.setMode('synth'));
    document.getElementById('midi-in-mode-arp')?.addEventListener('click',   () => this.setMode('arp'));

    // Mode buttons IN2
    document.getElementById('midi-in-mode2-synth')?.addEventListener('click', () => this.setMode2('synth'));
    document.getElementById('midi-in-mode2-arp')?.addEventListener('click',   () => this.setMode2('arp'));

    // CC Learn (forward)
    document.getElementById('midi-in-learn')?.addEventListener('click', () => {
      const learnSelect = document.getElementById('midi-in-learn-target') as HTMLSelectElement | null;
      const targetName = learnSelect ? learnSelect.value : '';
      if (!targetName) {
        this.updateStatus('ターゲットを選択');
        return;
      }
      const targetDef = this.ccLearnTargets.find(t => t.target === targetName);
      if (!targetDef) return;

      const devSelect = document.getElementById('midi-in-learn-dev') as HTMLSelectElement | null;
      const dev = devSelect ? devSelect.value : '1';
      const entry = { target: targetDef.target, min: targetDef.min, max: targetDef.max };

      this.cancelReverseLearn();
      if (dev === '2') {
        this.ccLearnTarget2 = entry;
        this.ccLearnActive2 = true;
        this.ccLearnActive = false;
      } else {
        this.ccLearnTarget = entry;
        this.ccLearnActive = true;
        this.ccLearnActive2 = false;
      }

      document.getElementById('midi-in-learn')?.classList.add('active');
      this.updateStatus('LEARN IN' + dev + ': ' + targetDef.label + ' — CCを動かす');
    });

    // Reverse Learn
    document.getElementById('midi-in-rlearn')?.addEventListener('click', () => {
      const devSelect = document.getElementById('midi-in-learn-dev') as HTMLSelectElement | null;
      const dev = devSelect ? devSelect.value : '1';
      this.armReverseLearn(dev);
    });

    // Banks
    document.getElementById('midi-bank-select')?.addEventListener('change', (e) => {
      this.loadBank(parseInt((e.target as HTMLSelectElement).value, 10));
    });
    document.getElementById('midi-bank-save')?.addEventListener('click', () => this.saveBank());
    document.getElementById('midi-bank-del')?.addEventListener('click', () => this.deleteBank());

    // Export / Import config
    document.getElementById('midi-cfg-export')?.addEventListener('click', () => this.exportConfig());
    document.getElementById('midi-cfg-import')?.addEventListener('click', () => this.importConfig());
  }

  setMode(mode: string) {
    this.mode = mode;
    document.getElementById('midi-in-mode-synth')?.classList.toggle('active', mode === 'synth');
    document.getElementById('midi-in-mode-arp')?.classList.toggle('active',   mode === 'arp');
    this.saveConfig();
  }

  setMode2(mode: string) {
    this.mode2 = mode;
    document.getElementById('midi-in-mode2-synth')?.classList.toggle('active', mode === 'synth');
    document.getElementById('midi-in-mode2-arp')?.classList.toggle('active',   mode === 'arp');
    this.saveConfig();
  }

  populateInputs() {
    const select  = document.getElementById('midi-in-select') as HTMLSelectElement | null;
    const select2 = document.getElementById('midi-in-select2') as HTMLSelectElement | null;
    if (!this.midiAccess) return;

    const buildOptions = (sel: HTMLSelectElement | null) => {
      if (!sel) return;
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">-- No Device --</option>';
      this.midiAccess!.inputs.forEach(input => {
        const opt = document.createElement('option');
        opt.value = input.id;
        opt.textContent = input.name || `Input ${input.id}`;
        sel.appendChild(opt);
      });
      // Restore previous selection if still available
      if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
        sel.value = currentVal;
      }
    };

    buildOptions(select);
    buildOptions(select2);

    // --- TEMP DIAGNOSTIC (remove after debugging) ---
    // enabled ゲートやデバイス選択に関係なく、全入力の生メッセージをログする。
    // これで「ハードから信号が来ているか」を確実に確認できる。
    this.midiAccess.inputs.forEach(input => {
      if ((input as any)._dbgAttached) return;
      (input as any)._dbgAttached = true;
      try { input.open(); } catch (e) {}
      input.addEventListener('midimessage', (ev: MIDIMessageEvent) => {
        console.log('[MIDI IN RAW]', input.name, Array.from(ev.data!),
                    '| enabled =', this.enabled,
                    '| selectedIN1 =', this.selectedInput?.name ?? '(none)');
      });
    });
    // ------------------------------------------------

    // Restore device by saved name (from preset load)
    if (this._pendingDeviceName) {
      for (const [id, input] of this.midiAccess.inputs) {
        if (input.name === this._pendingDeviceName) {
          this.selectedInput = input;
          input.onmidimessage = (ev) => this.handleMessage(ev);
          if (select) select.value = id;
          this._pendingDeviceName = null;
          break;
        }
      }
    }
    if (this._pendingDeviceName2) {
      for (const [id, input] of this.midiAccess.inputs) {
        if (input.name === this._pendingDeviceName2) {
          this.selectedInput2 = input;
          input.onmidimessage = (ev) => this.handleMessage2(ev);
          if (select2) select2.value = id;
          this._pendingDeviceName2 = null;
          break;
        }
      }
    }

    // Auto-select first device for IN1 if not yet set
    if (this.midiAccess.inputs.size > 0 && !this.selectedInput) {
      const first = this.midiAccess.inputs.values().next().value;
      if (first) {
        this.selectedInput = first;
        first.onmidimessage = (ev: MIDIMessageEvent) => this.handleMessage(ev);
        if (select) select.value = first.id;
      }
    }
  }

  updateStatus(text: string) {
    const el = document.getElementById('midi-in-status');
    if (el) el.textContent = text;
  }

  // ===== INDEPENDENT PERSISTENCE =====
  // MIDI controller config lives in its own localStorage key, separate from
  // the musical sound-preset blob, and is saved on every change.

  saveConfig() {
    try {
      const cfg = {
        version: 1,
        enabled: this.enabled,
        in1: {
          deviceName: this.selectedInput ? this.selectedInput.name : null,
          mode: this.mode,
          ccMap: this.ccMap,
        },
        in2: {
          deviceName: this.selectedInput2 ? this.selectedInput2.name : null,
          mode: this.mode2,
          ccMap: this.ccMap2,
        },
        banks: this.banks,
        activeBank: this.activeBank,
      };
      localStorage.setItem(this.configKey, JSON.stringify(cfg));
    } catch (e) {
      console.warn('MIDI saveConfig failed:', e);
    }
  }

  loadConfig() {
    let cfg = null;
    try {
      const raw = localStorage.getItem(this.configKey);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) {}

    // One-time migration: if no dedicated config exists yet, pull any mapping
    // that was previously stored inside the old sound-preset blob so existing
    // users don't lose their setup.
    if (!cfg) {
      cfg = this._migrateFromPreset();
    }
    if (!cfg) return;

    this.applyConfig(cfg);
    // Persist (covers the migration case)
    this.saveConfig();
  }

  applyConfig(cfg: any) {
    if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
    if (cfg.in1) {
      if (cfg.in1.ccMap) this.ccMap = cfg.in1.ccMap;
      if (cfg.in1.mode) this.mode = cfg.in1.mode;
      this._pendingDeviceName = cfg.in1.deviceName || null;
    }
    if (cfg.in2) {
      if (cfg.in2.ccMap) this.ccMap2 = cfg.in2.ccMap;
      if (cfg.in2.mode) this.mode2 = cfg.in2.mode;
      this._pendingDeviceName2 = cfg.in2.deviceName || null;
    }
    if (Array.isArray(cfg.banks)) this.banks = cfg.banks;
    if (typeof cfg.activeBank === 'number') this.activeBank = cfg.activeBank;
  }

  _migrateFromPreset() {
    try {
      const raw = localStorage.getItem('DLOSy20_preset');
      if (!raw) return null;
      const preset = JSON.parse(raw);
      const m = preset && preset.midiIn;
      if (!m) return null;
      console.log('MIDI: migrating mapping from old preset blob');
      return {
        version: 1,
        enabled: !!m.enabled,
        in1: { deviceName: m.deviceName || null,  mode: m.mode || 'synth',  ccMap: m.ccMap || {} },
        in2: { deviceName: m.deviceName2 || null, mode: m.mode2 || 'synth', ccMap: m.ccMap2 || {} },
        banks: [] as MidiBank[],
        activeBank: -1,
      };
    } catch (e) {
      return null;
    }
  }

  // Reflect loaded state onto the DOM (called once after loadConfig)
  syncUIFromState() {
    document.getElementById('midi-in-toggle')?.classList.toggle('midi-active', this.enabled);
    this.updateStatus(this.enabled ? 'ON' : 'Off');
    document.getElementById('midi-in-mode-synth')?.classList.toggle('active', this.mode === 'synth');
    document.getElementById('midi-in-mode-arp')?.classList.toggle('active',   this.mode === 'arp');
    document.getElementById('midi-in-mode2-synth')?.classList.toggle('active', this.mode2 === 'synth');
    document.getElementById('midi-in-mode2-arp')?.classList.toggle('active',   this.mode2 === 'arp');
  }

  // ===== MAPPING TABLE UI =====

  labelFor(target: string) {
    const def = this.ccLearnTargets.find(t => t.target === target);
    return def ? def.label : target;
  }

  renderMaps() {
    this._renderMapTable('midi-map-table1', this.ccMap, '1');
    this._renderMapTable('midi-map-table2', this.ccMap2, '2');
  }

  _renderMapTable(elId: string, map: CCMap, dev: string) {
    const el = document.getElementById(elId);
    if (!el) return;
    const entries = Object.entries(map)
      .map(([cc, m]) => [parseInt(cc, 10), m] as [number, CCMapping])
      .sort((a, b) => a[0] - b[0]);

    let rows = '';
    if (entries.length === 0) {
      rows = `<div class="midi-map-empty">マッピングなし</div>`;
    } else {
      rows = entries.map(([cc, m]) => `
        <div class="midi-map-row">
          <span class="mm-cc">CC${cc}</span>
          <span class="mm-tgt" title="${this.labelFor(m.target)}">${this.labelFor(m.target)}</span>
          <span class="mm-range">${this._fmt(m.min)}–${this._fmt(m.max)}</span>
          <button class="mm-del" data-dev="${dev}" data-cc="${cc}" title="削除">×</button>
        </div>`).join('');
    }

    el.innerHTML = `
      <div class="midi-map-title">IN${dev} MAP <span class="mm-count">${entries.length}</span></div>
      ${rows}`;

    el.querySelectorAll<HTMLElement>('.mm-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.deleteMapping(btn.dataset.dev ?? "", parseInt(btn.dataset.cc ?? "0", 10));
      });
    });
  }

  _fmt(v: number) {
    if (v === undefined || v === null) return '?';
    return (Math.abs(v) < 1 && v !== 0) ? v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : String(Math.round(v));
  }

  deleteMapping(dev: string, cc: number) {
    const map = dev === '2' ? this.ccMap2 : this.ccMap;
    delete map[cc];
    this.renderMaps();
    this.saveConfig();
    this.updateStatus('CC' + cc + ' (IN' + dev + ') 削除');
  }

  // ===== REVERSE LEARN =====
  // Move a CC first; it gets captured, then click any on-screen control that
  // carries data-midi-target or data-param to bind it.

  armReverseLearn(dev: string) {
    this.cancelReverseLearn();
    this.ccLearnActive = false;
    this.ccLearnActive2 = false;
    document.getElementById('midi-in-learn')?.classList.remove('active');

    this.reverseLearnDev = dev;
    this.reverseCC = null;
    document.getElementById('midi-in-rlearn')?.classList.add('active');
    document.body.classList.add('midi-reverse-arming');
    this.updateStatus('REVERSE IN' + dev + ': CCを動かす…');
  }

  _captureReverseCC(ccNumber: number) {
    this.reverseCC = ccNumber;
    document.body.classList.remove('midi-reverse-arming');
    document.body.classList.add('midi-reverse-pick');
    this.updateStatus('CC' + ccNumber + ' 検出 — 対象をクリック');

    // One-shot capture-phase click handler to grab the target control
    this._reverseClickHandler = (e: MouseEvent) => {
      // Ignore clicks inside the MIDI panel itself (e.g. cancel)
      const tgt = e.target as HTMLElement;
      if (tgt.closest('#midi-in-panel')) {
        this.cancelReverseLearn();
        this.updateStatus('REVERSE 中止');
        return;
      }
      const resolved = this.resolveTargetFromEl(tgt);
      if (!resolved) {
        // Not a mappable control — keep waiting
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const map = this.reverseLearnDev === '2' ? this.ccMap2 : this.ccMap;
      map[this.reverseCC!] = { target: resolved.target ?? "", min: resolved.min, max: resolved.max };
      const dev = this.reverseLearnDev;
      const cc = this.reverseCC;
      this.cancelReverseLearn();
      this.renderMaps();
      this.saveConfig();
      this.updateStatus('CC' + cc + ' → ' + resolved.label + ' (IN' + dev + ')');
    };
    document.addEventListener('click', this._reverseClickHandler, true);
  }

  cancelReverseLearn() {
    this.reverseLearnDev = null;
    this.reverseCC = null;
    if (this._reverseClickHandler) {
      document.removeEventListener('click', this._reverseClickHandler, true);
      this._reverseClickHandler = null;
    }
    document.getElementById('midi-in-rlearn')?.classList.remove('active');
    document.body.classList.remove('midi-reverse-arming', 'midi-reverse-pick');
  }

  // Resolve a clicked DOM element into a mapping target + range.
  resolveTargetFromEl(el: HTMLElement) {
    const t = el.closest('[data-midi-target]');
    if (t) {
      const id = t.getAttribute('data-midi-target');
      const def = this.ccLearnTargets.find(d => d.target === id);
      return { target: id, min: def ? def.min : 0, max: def ? def.max : 1, label: def ? def.label : id };
    }
    const p = el.closest('[data-param]');
    if (p) {
      const id = p.getAttribute('data-param');
      const def = this.ccLearnTargets.find(d => d.target === id);
      let min = parseFloat(p.getAttribute("data-min") ?? "");
      let max = parseFloat(p.getAttribute("data-max") ?? "");
      if (isNaN(min)) min = def ? def.min : 0;
      if (isNaN(max)) max = def ? def.max : 1;
      return { target: id, min, max, label: def ? def.label : id };
    }
    return null;
  }

  // ===== BANKS =====

  refreshBankSelect() {
    const sel = document.getElementById('midi-bank-select') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = '<option value="-1">— Bank —</option>';
    this.banks.forEach((b, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = b.name || ('Bank ' + (i + 1));
      sel.appendChild(opt);
    });
    sel.value = String(this.activeBank);
  }

  saveBank() {
    const name = (window.prompt('バンク名:', 'Bank ' + (this.banks.length + 1)) || '').trim();
    if (!name) return;
    this.banks.push({
      name,
      ccMap: JSON.parse(JSON.stringify(this.ccMap)),
      ccMap2: JSON.parse(JSON.stringify(this.ccMap2)),
    });
    this.activeBank = this.banks.length - 1;
    this.refreshBankSelect();
    this.saveConfig();
    this.updateStatus('Bank保存: ' + name);
  }

  loadBank(index: number) {
    if (index < 0 || index >= this.banks.length) {
      this.activeBank = -1;
      return;
    }
    const b = this.banks[index];
    this.ccMap  = JSON.parse(JSON.stringify(b.ccMap  || {}));
    this.ccMap2 = JSON.parse(JSON.stringify(b.ccMap2 || {}));
    this.activeBank = index;
    this.renderMaps();
    this.saveConfig();
    this.updateStatus('Bank: ' + (b.name || index));
  }

  deleteBank() {
    if (this.activeBank < 0 || this.activeBank >= this.banks.length) {
      this.updateStatus('バンク未選択');
      return;
    }
    const removed = this.banks.splice(this.activeBank, 1)[0];
    this.activeBank = -1;
    this.refreshBankSelect();
    this.saveConfig();
    this.updateStatus('Bank削除: ' + (removed?.name || ''));
  }

  // ===== EXPORT / IMPORT =====

  exportConfig() {
    const cfg = {
      version: 1,
      enabled: this.enabled,
      in1: { deviceName: this.selectedInput ? this.selectedInput.name : null,  mode: this.mode,  ccMap: this.ccMap },
      in2: { deviceName: this.selectedInput2 ? this.selectedInput2.name : null, mode: this.mode2, ccMap: this.ccMap2 },
      banks: this.banks,
      activeBank: this.activeBank,
    };
    const json = JSON.stringify(cfg, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '') + '_' +
                  now.toTimeString().slice(0, 5).replace(':', '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `DLOSy20_midi_${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.updateStatus('MIDI設定をエクスポート');
  }

  importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const cfg = JSON.parse((ev.target as FileReader).result as string);
          this.applyConfig(cfg);
          this.renderMaps();
          this.refreshBankSelect();
          this.syncUIFromState();
          if (this.midiAccess) this.populateInputs();
          this.saveConfig();
          this.updateStatus('MIDI設定をインポート: ' + file.name);
        } catch (err) {
          console.error('MIDI import error:', err);
          this.updateStatus('⚠ インポート失敗');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }
}

export const midiIn = new MidiIn();
