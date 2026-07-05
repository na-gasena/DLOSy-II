/**
 * DLOSy20 - Effects Engine
 * Audio effects chain with UI generation
 * Based on osci-render effect analysis
 */
import { audioEngine } from './audio-engine';
import { registerSerializable } from './registry';
import { emit } from './events';
import { attachRotaryKnob } from './param-control';

interface EffectParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  value: number;
  step: number;
}

interface EffectDef {
  id: string;
  name: string;
  category: string;
  desc: string;
  params: EffectParamDef[];
}

interface EffectState {
  enabled: boolean;
  dryWet: number;
  params: Record<string, number>;
}

interface EffectWrapper {
  dryGain: GainNode;
  wetGain: GainNode;
  mixer: GainNode;
}

class EffectsEngine {
  effectDefs: EffectDef[];
  effects: Record<string, EffectState>;
  effectOrder: string[];
  _draggedId: string | null;
  audioNodesReady: boolean = false;

  // Web Audio nodes (built lazily in initAudioNodes)
  distortNode!: WaveShaperNode;
  bitcrushNode!: ScriptProcessorNode;
  fxDelayNode!: DelayNode;
  fxDelayFeedback!: GainNode;
  fxDelayWet!: GainNode;
  fxDelayDry!: GainNode;
  fxDelayInput!: GainNode;
  fxDelayOutput!: GainNode;
  smoothFilter!: BiquadFilterNode;
  wobbleLfo!: OscillatorNode;
  wobbleLfoGain!: GainNode;
  wobbleNode!: GainNode;
  rotateNode!: ScriptProcessorNode;
  scaleNode!: ScriptProcessorNode;
  rippleNode!: ScriptProcessorNode;
  stereoNode!: ScriptProcessorNode;
  vectorCancelNode!: ScriptProcessorNode;
  flipXNode!: ScriptProcessorNode;
  flipYNode!: ScriptProcessorNode;
  phaserInput!: GainNode;
  phaserDry!: GainNode;
  phaserWet!: GainNode;
  phaserFb!: GainNode;
  phaserOutput!: GainNode;
  phaserStages!: BiquadFilterNode[];
  phaserLfo!: OscillatorNode;
  phaserLfoGain!: GainNode;
  phaserFbDelay!: DelayNode;
  effectWrappers!: Record<string, EffectWrapper>;
  _rotatePhase: number = 0;
  _ripplePhase: number = 0;
  _stereoBuffer!: Float32Array;
  _stereoHead: number = 0;
  _vcCounter: number = 0;

  constructor() {
    // Effect definitions
    this.effectDefs = [
      {
        id: 'distort', name: 'Distort', category: 'signal',
        desc: '波形を歪ませてハーモニクスを追加',
        params: [{ id: 'amount', name: 'Amount', min: 0, max: 1, value: 0, step: 0.01 }]
      },
      {
        id: 'bitcrush', name: 'Bit Crush', category: 'signal',
        desc: '解像度を制限してローファイな音に',
        params: [{ id: 'strength', name: 'Strength', min: 0, max: 1, value: 0.5, step: 0.01 }]
      },
      {
        id: 'delay', name: 'Delay', category: 'signal',
        desc: 'エコー/ディレイ効果',
        params: [
          { id: 'time', name: 'Time', min: 0.01, max: 1, value: 0.3, step: 0.01 },
          { id: 'feedback', name: 'Feedback', min: 0, max: 0.9, value: 0.4, step: 0.01 }
        ]
      },
      {
        id: 'smooth', name: 'Smooth (LPF)', category: 'signal',
        desc: 'ローパスフィルタで高域を削る',
        params: [{ id: 'cutoff', name: 'Cutoff', min: 100, max: 8000, value: 4000, step: 10 }]
      },
      {
        id: 'wobble', name: 'Wobble', category: 'signal',
        desc: '周波数を微妙にずらして揺らぎを追加',
        params: [
          { id: 'amount', name: 'Amount', min: 0, max: 1, value: 0.3, step: 0.01 },
          { id: 'rate', name: 'Rate', min: 0.1, max: 10, value: 2, step: 0.1 }
        ]
      },
      {
        id: 'phaser', name: 'Phaser', category: 'signal',
        desc: '位相シフトで音色を揺らす（LFO付き）',
        params: [
          { id: 'rate',     name: 'Rate',     min: 0.05, max: 5,   value: 0.5, step: 0.05 },
          { id: 'depth',    name: 'Depth',    min: 0,    max: 1,   value: 0.7, step: 0.01 },
          { id: 'feedback', name: 'Feedback', min: 0,    max: 0.9, value: 0.3, step: 0.01 },
        ]
      },
      {
        id: 'rotate', name: 'Rotate', category: 'waveform',
        desc: 'XY波形座標を回転',
        params: [{ id: 'speed', name: 'Speed', min: 0, max: 1, value: 0.2, step: 0.01 }]
      },
      {
        id: 'scale', name: 'Scale', category: 'waveform',
        desc: '波形の拡縮',
        params: [
          { id: 'x', name: 'Scale X', min: 0.1, max: 3, value: 1, step: 0.01 },
          { id: 'y', name: 'Scale Y', min: 0.1, max: 3, value: 1, step: 0.01 }
        ]
      },
      {
        id: 'ripple', name: 'Ripple', category: 'waveform',
        desc: '波紋状の歪みを適用',
        params: [
          { id: 'depth', name: 'Depth', min: 0, max: 1, value: 0.2, step: 0.01 },
          { id: 'rate', name: 'Rate', min: 0.1, max: 10, value: 2, step: 0.1 }
        ]
      },
      {
        id: 'stereo', name: 'Stereo', category: 'signal',
        desc: 'モノラルをステレオに広げる',
        params: [{ id: 'width', name: 'Width', min: 0, max: 1, value: 0.3, step: 0.01 }]
      },
      {
        id: 'vectorcancel', name: 'Vector Cancel', category: 'waveform',
        desc: '位相を高速反転（映像を残し音を消す）',
        params: [{ id: 'amount', name: 'Amount', min: 0, max: 1, value: 0.5, step: 0.01 }]
      },
      {
        id: 'flipx', name: 'Flip X', category: 'waveform',
        desc: 'X軸（左チャンネル）を反転',
        params: []
      },
      {
        id: 'flipy', name: 'Flip Y', category: 'waveform',
        desc: 'Y軸（右チャンネル）を反転',
        params: []
      },
    ];

    // Effect states
    this.effects = {};
    this.effectDefs.forEach(def => {
      this.effects[def.id] = {
        enabled: false,
        dryWet: 1.0,
        params: {}
      };
      def.params.forEach(p => {
        this.effects[def.id].params[p.id] = p.value;
      });
    });

    // Effect order (drag-reorderable)
    this.effectOrder = this.effectDefs.map(d => d.id);
    this._draggedId = null;
  }

  init() {
    this.buildUI();
    // Audio nodes will be initialized when audio engine is ready
    this.audioNodesReady = false;
  }

  // ===== WEB AUDIO EFFECTS CHAIN =====

  initAudioNodes() {
    if (!audioEngine || !audioEngine.ctx || !audioEngine.fxInput) return;
    if (this.audioNodesReady) return;

    const ctx = audioEngine.ctx!;
    // ScriptProcessorNode runs its onaudioprocess callback on the MAIN thread,
    // so the buffer must be refilled before it drains. At 256 samples (~5ms @48k)
    // any main-thread jank (canvas redraw, GC, layout) underruns it and produces
    // audible clicks/pops ("ぷつぷつ"). 1024 (~21ms) is far more robust; the extra
    // latency is unnoticeable for these character/glitch effects.
    const BUFSIZE = 1024;

    // --- Distort (WaveShaper) ---
    this.distortNode = ctx.createWaveShaper();
    this.distortNode.oversample = '4x';
    this.updateDistortCurve();

    // --- Bit Crush (ScriptProcessor: quantize) ---
    this.bitcrushNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.bitcrushNode.onaudioprocess = (e) => {
      const str = this.effects.bitcrush.params.strength;
      const powVal = Math.pow(2, 1 + (1 - str) * 10);
      for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
        const inp = e.inputBuffer.getChannelData(ch);
        const out = e.outputBuffer.getChannelData(ch);
        for (let i = 0; i < inp.length; i++) {
          out[i] = Math.round(inp[i] * powVal) / powVal;
        }
      }
    };

    // --- Delay ---
    this.fxDelayNode = ctx.createDelay(2.0);
    this.fxDelayFeedback = ctx.createGain();
    this.fxDelayWet = ctx.createGain();
    this.fxDelayDry = ctx.createGain();
    this.fxDelayInput = ctx.createGain();
    this.fxDelayOutput = ctx.createGain();
    this.fxDelayInput.connect(this.fxDelayDry);
    this.fxDelayDry.connect(this.fxDelayOutput);
    this.fxDelayInput.connect(this.fxDelayNode);
    this.fxDelayNode.connect(this.fxDelayFeedback);
    this.fxDelayFeedback.connect(this.fxDelayNode);
    this.fxDelayNode.connect(this.fxDelayWet);
    this.fxDelayWet.connect(this.fxDelayOutput);
    this.updateDelayParams();

    // --- Smooth (LPF) ---
    this.smoothFilter = ctx.createBiquadFilter();
    this.smoothFilter.type = 'lowpass';
    this.smoothFilter.Q.value = 0.7;
    this.updateSmoothParams();

    // --- Wobble (LFO modulating gain) ---
    this.wobbleLfo = ctx.createOscillator();
    this.wobbleLfoGain = ctx.createGain();
    this.wobbleNode = ctx.createGain();
    this.wobbleLfo.type = 'sine';
    this.wobbleLfo.connect(this.wobbleLfoGain);
    this.wobbleLfoGain.connect(this.wobbleNode.gain);
    this.wobbleLfo.start();
    this.updateWobbleParams();

    // --- Rotate (ScriptProcessor: L/R rotation matrix) ---
    this._rotatePhase = 0;
    this.rotateNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.rotateNode.onaudioprocess = (e) => {
      const speed = this.effects.rotate.params.speed;
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const phaseInc = speed * Math.PI * 2 / audioEngine.ctx!.sampleRate;
      for (let i = 0; i < inL.length; i++) {
        this._rotatePhase += phaseInc;
        const cos = Math.cos(this._rotatePhase);
        const sin = Math.sin(this._rotatePhase);
        outL[i] = inL[i] * cos - inR[i] * sin;
        outR[i] = inL[i] * sin + inR[i] * cos;
      }
    };

    // --- Scale (ScriptProcessor: L*scaleX, R*scaleY) ---
    this.scaleNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.scaleNode.onaudioprocess = (e) => {
      const sx = this.effects.scale.params.x;
      const sy = this.effects.scale.params.y;
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < inL.length; i++) {
        outL[i] = inL[i] * sx;
        outR[i] = inR[i] * sy;
      }
    };

    // --- Ripple (ScriptProcessor: sin-based waveform distortion) ---
    this._ripplePhase = 0;
    this.rippleNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.rippleNode.onaudioprocess = (e) => {
      const depth = this.effects.ripple.params.depth;
      const rate = this.effects.ripple.params.rate;
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const phaseInc = rate * Math.PI * 2 / audioEngine.ctx!.sampleRate;
      for (let i = 0; i < inL.length; i++) {
        this._ripplePhase += phaseInc;
        const dist = Math.sqrt(inL[i] * inL[i] + inR[i] * inR[i]);
        const ripple = Math.sin(dist * 30 + this._ripplePhase) * depth * 0.3;
        outL[i] = inL[i] + ripple;
        outR[i] = inR[i] + ripple;
      }
    };

    // --- Stereo (ScriptProcessor: delay R channel) ---
    this._stereoBuffer = new Float32Array(4800); // ~100ms at 48kHz
    this._stereoHead = 0;
    this.stereoNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.stereoNode.onaudioprocess = (e) => {
      const width = this.effects.stereo.params.width;
      const delaySamples = Math.floor(width * this._stereoBuffer.length);
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < inL.length; i++) {
        this._stereoBuffer[this._stereoHead] = inR[i];
        let readPos = this._stereoHead - delaySamples;
        if (readPos < 0) readPos += this._stereoBuffer.length;
        outL[i] = inL[i];
        outR[i] = this._stereoBuffer[readPos];
        this._stereoHead = (this._stereoHead + 1) % this._stereoBuffer.length;
      }
    };

    // --- VectorCancel (ScriptProcessor: periodic phase invert) ---
    this._vcCounter = 0;
    this.vectorCancelNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.vectorCancelNode.onaudioprocess = (e) => {
      const amt = this.effects.vectorcancel.params.amount;
      const period = Math.max(2, Math.round(20 * (1 - amt)));
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < inL.length; i++) {
        this._vcCounter++;
        const invert = (Math.floor(this._vcCounter / period) % 2 === 1) ? -1 : 1;
        outL[i] = inL[i] * invert;
        outR[i] = inR[i] * invert;
      }
    };

    // --- Flip X (ScriptProcessor: invert left channel) ---
    this.flipXNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.flipXNode.onaudioprocess = (e) => {
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < inL.length; i++) {
        outL[i] = -inL[i];
        outR[i] =  inR[i];
      }
    };

    // --- Flip Y (ScriptProcessor: invert right channel) ---
    this.flipYNode = ctx.createScriptProcessor(BUFSIZE, 2, 2);
    this.flipYNode.onaudioprocess = (e) => {
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.getChannelData(1);
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < inL.length; i++) {
        outL[i] =  inL[i];
        outR[i] = -inR[i];
      }
    };

    // --- Phaser (4-stage allpass + LFO) ---
    this.phaserInput  = ctx.createGain();
    this.phaserDry    = ctx.createGain();
    this.phaserWet    = ctx.createGain();
    this.phaserFb     = ctx.createGain();
    this.phaserOutput = ctx.createGain();

    const phaserCenterFreqs = [400, 800, 1200, 1600];
    this.phaserStages = phaserCenterFreqs.map(f => {
      const node = ctx.createBiquadFilter();
      node.type = 'allpass';
      node.frequency.value = f;
      node.Q.value = 10;
      return node;
    });

    this.phaserLfo     = ctx.createOscillator();
    this.phaserLfoGain = ctx.createGain();
    this.phaserLfo.type = 'sine';
    this.phaserLfo.connect(this.phaserLfoGain);
    this.phaserLfo.start();
    this.updatePhaserParams();

    // 1-sample delay to break zero-delay feedback loop in phaser
    this.phaserFbDelay = ctx.createDelay(0.1);
    this.phaserFbDelay.delayTime.value = 1 / ctx.sampleRate;

    // Per-effect dry/wet wrapper nodes
    this.effectWrappers = {};
    this.effectDefs.forEach(def => {
      const dryGain = ctx.createGain();
      const wetGain = ctx.createGain();
      const mixer   = ctx.createGain();
      mixer.gain.value = 1;
      this.effectWrappers[def.id] = { dryGain, wetGain, mixer };
    });

    this.audioNodesReady = true;
    this.rebuildChain();
  }

  rebuildChain() {
    if (!this.audioNodesReady) return;
    const ae = audioEngine;

    // Disconnect ALL nodes first to prevent stale connections / noise
    const allNodes = [
      ae.fxInput,
      this.distortNode,
      this.bitcrushNode,
      this.smoothFilter,
      this.wobbleLfo,
      this.wobbleLfoGain,
      this.wobbleNode,
      this.rotateNode,
      this.scaleNode,
      this.rippleNode,
      this.stereoNode,
      this.vectorCancelNode,
      this.flipXNode,
      this.flipYNode,
      this.fxDelayInput,
      this.fxDelayOutput,
      this.fxDelayNode,
      this.fxDelayFeedback,
      this.fxDelayWet,
      this.fxDelayDry,
      this.phaserLfo,
      this.phaserLfoGain,
      this.phaserInput, this.phaserDry, this.phaserWet,
      this.phaserFb, this.phaserFbDelay, this.phaserOutput,
      ...(this.phaserStages || []),
    ];
    // Add dry/wet wrapper nodes
    Object.values(this.effectWrappers || {}).forEach(w => {
      allNodes.push(w.dryGain, w.wetGain, w.mixer);
    });
    for (const node of allNodes) {
      if (node) try { node.disconnect(); } catch(e) {}
    }

    // Re-establish internal Delay sub-graph connections (these are always needed)
    this.fxDelayInput.connect(this.fxDelayDry);
    this.fxDelayDry.connect(this.fxDelayOutput);
    this.fxDelayInput.connect(this.fxDelayNode);
    this.fxDelayNode.connect(this.fxDelayFeedback);
    this.fxDelayFeedback.connect(this.fxDelayNode);
    this.fxDelayNode.connect(this.fxDelayWet);
    this.fxDelayWet.connect(this.fxDelayOutput);

    // Re-establish Wobble LFO connection
    this.wobbleLfo.connect(this.wobbleLfoGain);
    this.wobbleLfoGain.connect(this.wobbleNode.gain);

    // Re-establish Phaser LFO + internal connections
    if (this.phaserLfo && this.phaserStages) {
      this.phaserLfo.connect(this.phaserLfoGain);
      this.phaserStages.forEach(s => this.phaserLfoGain.connect(s.frequency));

      this.phaserInput.connect(this.phaserDry);
      this.phaserDry.connect(this.phaserOutput);
      let prev = this.phaserInput;
      this.phaserStages.forEach(s => { prev.connect(s); prev = s; });
      prev.connect(this.phaserWet);
      this.phaserWet.connect(this.phaserOutput);
      prev.connect(this.phaserFb);
      this.phaserFb.connect(this.phaserFbDelay);
      this.phaserFbDelay.connect(this.phaserStages[0]);
    }

    // Build chain: fxInput → [enabled effects in effectOrder] → fxOutput
    const nodeMap = {
      distort:      { node: this.distortNode },
      bitcrush:     { node: this.bitcrushNode },
      smooth:       { node: this.smoothFilter },
      wobble:       { node: this.wobbleNode },
      rotate:       { node: this.rotateNode },
      scale:        { node: this.scaleNode },
      ripple:       { node: this.rippleNode },
      stereo:       { node: this.stereoNode },
      vectorcancel: { node: this.vectorCancelNode },
      flipx:        { node: this.flipXNode },
      flipy:        { node: this.flipYNode },
      delay:        { input: this.fxDelayInput,  output: this.fxDelayOutput },
      phaser:       { input: this.phaserInput,   output: this.phaserOutput  },
    };

    let current = ae.fxInput!;
    for (const id of this.effectOrder) {
      const state = this.effects[id];
      if (!state.enabled) continue;

      if (id === 'distort')      this.updateDistortCurve();
      else if (id === 'smooth')  this.updateSmoothParams();
      else if (id === 'wobble')  this.updateWobbleParams();
      else if (id === 'delay')   this.updateDelayParams();
      else if (id === 'phaser')  this.updatePhaserParams();

      const m = (nodeMap as any)[id];
      const effectIn  = m.input  || m.node;
      const effectOut = m.output || m.node;
      const w = this.effectWrappers[id];
      const dw = state.dryWet;

      w.dryGain.gain.value = 1 - dw;
      w.wetGain.gain.value = dw;
      w.mixer.gain.value   = 1;

      current.connect(w.dryGain);
      w.dryGain.connect(w.mixer);
      current.connect(effectIn);
      effectOut.connect(w.wetGain);
      w.wetGain.connect(w.mixer);
      current = w.mixer;
    }

    current.connect(ae.fxOutput!);
  }

  updateDistortCurve() {
    const amt = this.effects.distort.params.amount;
    const samples = 44100;
    const curve = new Float32Array(samples);
    const k = amt * 50;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft clipping distortion curve
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.distortNode.curve = curve;
  }

  updateDelayParams() {
    const p = this.effects.delay.params;
    if (this.fxDelayNode) {
      this.fxDelayNode.delayTime.value = p.time;
      this.fxDelayFeedback.gain.value = p.feedback;
      this.fxDelayWet.gain.value = 0.5;
      this.fxDelayDry.gain.value = 1.0;
    }
  }

  updateSmoothParams() {
    if (this.smoothFilter) {
      this.smoothFilter.frequency.value = this.effects.smooth.params.cutoff;
    }
  }

  updatePhaserParams() {
    if (!this.phaserLfo || !this.phaserStages) return;
    const p = this.effects.phaser.params;
    this.phaserLfo.frequency.value = p.rate;
    this.phaserLfoGain.gain.value = p.depth * 350; // ±350Hz sweep (stage[0] base=400Hz, min stays ≥50Hz)
    this.phaserFb.gain.value = p.feedback;
    this.phaserDry.gain.value = 1;
    this.phaserWet.gain.value = 0.7;
  }

  updateWobbleParams() {
    const p = this.effects.wobble.params;
    if (this.wobbleLfo) {
      this.wobbleLfo.frequency.value = p.rate;
      this.wobbleLfoGain.gain.value = p.amount * 0.5;
      this.wobbleNode.gain.value = 1.0;
    }
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('panel-effects');
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">EFFECTS</div>
      <div class="effects-list" id="effects-list"></div>
    `;

    const list = document.getElementById('effects-list');
    this.effectOrder.forEach(id => {
      const def   = this.effectDefs.find(d => d.id === id);
      if (!def) return;
      const state = this.effects[def.id];

      const card = document.createElement('div');
      card.className = 'fx-card' + (state.enabled ? ' active' : '');
      card.id = `fx-card-${def.id}`;

      // Drag-to-reorder (draggable enabled only when mousedown on handle)
      card.draggable = false;
      card.addEventListener('dragstart', (e) => {
        this._draggedId = def.id;
        e.dataTransfer!.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.draggable = false;
        card.classList.remove('dragging');
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (!this._draggedId || this._draggedId === def.id) return;
        const fromIdx = this.effectOrder.indexOf(this._draggedId);
        const toIdx   = this.effectOrder.indexOf(def.id);
        if (fromIdx < 0 || toIdx < 0) return;
        this.effectOrder.splice(fromIdx, 1);
        this.effectOrder.splice(toIdx, 0, this._draggedId);
        this._draggedId = null;
        this.buildUI();
        if (this.audioNodesReady) this.rebuildChain();
        this.triggerAutoSave();
      });

      // Header with toggle
      const header = document.createElement('div');
      header.className = 'fx-header';

      // Drag handle
      const dragHandle = document.createElement('span');
      dragHandle.className = 'fx-drag-handle';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';
      dragHandle.addEventListener('mousedown', () => { card.draggable = true; });

      const toggle = document.createElement('button');
      toggle.className = 'fx-toggle' + (state.enabled ? ' on' : '');
      toggle.textContent = state.enabled ? 'ON' : 'OFF';
      toggle.addEventListener('click', () => {
        state.enabled = !state.enabled;
        toggle.classList.toggle('on', state.enabled);
        toggle.textContent = state.enabled ? 'ON' : 'OFF';
        card.classList.toggle('active', state.enabled);
        paramsDiv.style.display = state.enabled ? 'block' : 'none';

        if (audioEngine && audioEngine.isInitialized) {
          audioEngine.resume();
        }
        this.initAudioNodes();
        this.rebuildChain();
        this.triggerAutoSave();
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'fx-name';
      nameSpan.textContent = def.name;
      nameSpan.title = def.desc;

      // Dry/Wet knob (rotary drag — ui-study InputAngle pattern)
      const dwKnob = document.createElement('div');
      dwKnob.className = 'fx-dw-knob';
      dwKnob.title = 'Dry/Wet (回転ドラッグ · Alt=×0.1 · ダブルクリック=100%)';

      const dwValue = document.createElement('span');
      dwValue.className = 'fx-dw-value';
      dwValue.textContent = `${Math.round(state.dryWet * 100)}%`;

      const applyDryWet = (v: number) => {
        state.dryWet = v;
        dwValue.textContent = `${Math.round(v * 100)}%`;
        const w = this.effectWrappers?.[def.id];
        if (w) { w.wetGain.gain.value = v; w.dryGain.gain.value = 1 - v; }
      };
      attachRotaryKnob(dwKnob, {
        get: () => state.dryWet,
        set: applyDryWet,
        min: 0, max: 1, step: 0.01,
        defaultValue: 1.0,
        format: (v) => `${Math.round(v * 100)}%`,
        onCommit: () => this.triggerAutoSave(),
      });

      header.appendChild(dragHandle);
      header.appendChild(nameSpan);
      header.appendChild(dwKnob);
      header.appendChild(dwValue);
      header.appendChild(toggle);
      card.appendChild(header);

      // Parameters
      const paramsDiv = document.createElement('div');
      paramsDiv.className = 'fx-params';
      paramsDiv.style.display = state.enabled ? 'block' : 'none';

      def.params.forEach(p => {
        const row = document.createElement('div');
        row.className = 'fx-param-row';

        const label = document.createElement('span');
        label.className = 'fx-param-label';
        label.textContent = p.name;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'fx-slider';
        slider.min = String(p.min);
        slider.max = String(p.max);
        slider.step = String(p.step);
        slider.value = String(state.params[p.id]);

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'fx-param-value';
        valueDisplay.textContent = this.formatValue(state.params[p.id], p);

        slider.addEventListener('input', (e) => {
          const val = parseFloat((e.target as HTMLInputElement).value);
          state.params[p.id] = val;
          valueDisplay.textContent = this.formatValue(val, p);
          
          if (def.id === 'distort') this.updateDistortCurve();
          else if (def.id === 'delay') this.updateDelayParams();
          else if (def.id === 'smooth') this.updateSmoothParams();
          else if (def.id === 'phaser') this.updatePhaserParams();
          else if (def.id === 'wobble') this.updateWobbleParams();
          
          this.triggerAutoSave();
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(valueDisplay);
        paramsDiv.appendChild(row);
      });

      card.appendChild(paramsDiv);
      list?.appendChild(card);
    });
  }

  formatValue(val: number, paramDef: EffectParamDef): string {
    if (paramDef.max >= 100) return String(Math.round(val));
    return val.toFixed(2);
  }

  triggerAutoSave() {
    emit('state:changed');
  }

  // ===== STATE COLLECT / APPLY (for PresetManager) =====

  readonly stateKey = 'effects';

  getState() {
    return this.collectState();
  }

  setState(state: any) {
    this.applyState(state);
  }

  collectState() {
    const state: any = { __order: [...this.effectOrder] };
    Object.entries(this.effects).forEach(([id, fx]) => {
      state[id] = {
        enabled: fx.enabled,
        dryWet: fx.dryWet,
        params: { ...fx.params }
      };
    });
    return state;
  }

  applyState(saved: any) {
    if (!saved) return;
    if (Array.isArray(saved.__order)) {
      const known = this.effectDefs.map(d => d.id);
      this.effectOrder = [
        ...saved.__order.filter((id: string) => known.includes(id)),
        ...known.filter(id => !saved.__order.includes(id)),
      ];
    }
    Object.entries(saved).forEach(([id, data]: [string, any]) => {
      if (id === '__order') return;
      if (this.effects[id]) {
        this.effects[id].enabled = data.enabled;
        if (data.dryWet !== undefined) this.effects[id].dryWet = data.dryWet;
        Object.assign(this.effects[id].params, data.params);
      }
    });
    // Rebuild UI to reflect state
    this.buildUI();
    if (this.audioNodesReady) {
      this.rebuildChain();
    }
  }

  // ===== AUDIO PROCESSING =====
  // Apply effects to a sample (called per-sample or per-buffer)

  applyToPoint(x: number, y: number) {
    let outX = x, outY = y;

    // Rotate
    if (this.effects.rotate.enabled) {
      const speed = this.effects.rotate.params.speed;
      const angle = (performance.now() / 1000) * speed * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rx = outX * cos - outY * sin;
      const ry = outX * sin + outY * cos;
      outX = rx; outY = ry;
    }

    // Scale
    if (this.effects.scale.enabled) {
      outX *= this.effects.scale.params.x;
      outY *= this.effects.scale.params.y;
    }

    // Ripple
    if (this.effects.ripple.enabled) {
      const depth = this.effects.ripple.params.depth;
      const rate = this.effects.ripple.params.rate;
      const dist = Math.sqrt(outX * outX + outY * outY);
      const t = performance.now() / 1000;
      const ripple = Math.sin(dist * 20 * rate - t * rate * 5) * depth * 0.1;
      outX += ripple;
      outY += ripple;
    }

    // Distort
    if (this.effects.distort.enabled) {
      const amt = this.effects.distort.params.amount;
      outX = Math.tanh(outX * (1 + amt * 5));
      outY = Math.tanh(outY * (1 + amt * 5));
    }

    // Bit Crush
    if (this.effects.bitcrush.enabled) {
      const str = this.effects.bitcrush.params.strength;
      const levels = Math.pow(2, 1 + (1 - str) * 10);
      outX = Math.round(outX * levels) / levels;
      outY = Math.round(outY * levels) / levels;
    }

    // Vector Cancel
    if (this.effects.vectorcancel.enabled) {
      const amt = this.effects.vectorcancel.params.amount;
      this._vcCounter = (this._vcCounter || 0) + 1;
      if (this._vcCounter % Math.max(2, Math.round(10 * (1 - amt))) === 0) {
        outX = -outX;
        outY = -outY;
      }
    }

    return { x: outX, y: outY };
  }
}

export const effectsEngine = new EffectsEngine();
registerSerializable(effectsEngine);
