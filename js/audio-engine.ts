/**
 * DLOSy20 - Audio Engine
 * Web Audio API based synthesizer engine
 */
import { effectsEngine } from './effects-engine';
import { registerSerializable } from './registry';
import { emit } from './events';

// 'drawing' は Drawing Mode の波形を指すセンチネル。標準 OscillatorType に加えて
// アプリ全体で波形種別として保存・比較されるため、型に含める。
type WaveType = OscillatorType | 'drawing';

interface SynthParams {
  masterVol: number;
  synthVol: number;
  waveType: WaveType;
  cutoff: number;
  resonance: number;
  envAttack: number;
  envDecay: number;
  envSustain: number;
  envRelease: number;
  delayTime: number;
  delayFeedback: number;
  tempo: number;
  swing: number;
  octave: number;
  masterFreqShift: number;
}

class AudioEngine {
  ctx: AudioContext | null;
  masterGain: GainNode | null;
  isInitialized: boolean;
  sampleRate: number | null;
  latencyHint: AudioContextLatencyCategory;
  osc: OscillatorNode | null;
  oscGain: GainNode | null;
  filter: BiquadFilterNode | null;
  delayNode: DelayNode | null;
  delayFeedback: GainNode | null;
  delayWet: GainNode | null;
  fxInput: GainNode | null = null;
  fxOutput: GainNode | null = null;
  // Stereo phase stage (master path): up-mix to stereo, delay the R channel to
  // create an L/R phase difference (waveform preserved), then tap L/R for the
  // live XY (Lissajous) scope. Driven by the "PHASE" Lissajous pad.
  phaseStereoize: GainNode | null = null;
  phaseSplitter: ChannelSplitterNode | null = null;
  phaseDelayR: DelayNode | null = null;
  phaseMerger: ChannelMergerNode | null = null;
  scopeTap: GainNode | null = null;
  scopeAnalyserL: AnalyserNode | null = null;
  scopeAnalyserR: AnalyserNode | null = null;
  // Latest fundamental frequency set by any sound source (VCO Loop sweep, ARP
  // note, one-shot playFreq…). The stereo-phase DEG mode reads this to keep a
  // constant phase ANGLE as the pitch moves (delay = θ/360 / f).
  currentPitchHz = 0;
  params: SynthParams;
  noteFreqs: Record<string, number>;
  octaveMultipliers: number[];

  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isInitialized = false;
    this.sampleRate = 48000; // default 48kHz
    // 'interactive' (smallest buffer, lowest latency, most prone to dropouts),
    // 'balanced', or 'playback' (largest buffer, most stable). Wired through
    // from Audio Settings so the user can trade latency for glitch-free output.
    this.latencyHint = 'interactive';

    // Synth nodes
    this.osc = null;
    this.oscGain = null;
    this.filter = null;
    this.delayNode = null;
    this.delayFeedback = null;
    this.delayWet = null;

    // Parameters
    this.params = {
      masterVol: 0.7,
      synthVol: 0.5,
      waveType: 'sine',
      cutoff: 2000,
      resonance: 5,
      envAttack: 0.01,
      envDecay: 0.15,
      envSustain: 0.3,
      envRelease: 0.2,
      delayTime: 0.2,
      delayFeedback: 0.0,
      tempo: 120,
      swing: 0,
      octave: 1,
      masterFreqShift: 0,
    };

    // Note frequencies (C3 to C4)
    this.noteFreqs = {
      'C':  130.813,
      'C#': 138.591,
      'D':  146.832,
      'D#': 155.563,
      'E':  164.814,
      'F':  174.614,
      'F#': 184.997,
      'G':  195.998,
      'G#': 207.652,
      'A':  220.000,
      'A#': 233.082,
      'B':  246.942,
      'C4': 261.626,
    };

    // Octave multipliers
    this.octaveMultipliers = [0.25, 0.5, 1.0, 2.0, 4.0];
  }

  async init(sampleRate?: number | null, latencyHint?: AudioContextLatencyCategory) {
    if (this.isInitialized) return;
    if (sampleRate !== undefined) this.sampleRate = sampleRate;
    if (latencyHint !== undefined) this.latencyHint = latencyHint;

    const ctxOptions: AudioContextOptions = {};
    if (this.sampleRate) ctxOptions.sampleRate = this.sampleRate;
    if (this.latencyHint) ctxOptions.latencyHint = this.latencyHint;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioCtx(ctxOptions);

    // Master gain
    this.masterGain = this.ctx!.createGain();
    this.masterGain!.gain.value = this.params.masterVol;

    // Effects chain insert point: masterGain → fxInput → [effects] → fxOutput
    this.fxInput = this.ctx!.createGain();
    this.fxOutput = this.ctx!.createGain();
    this.masterGain!.connect(this.fxInput);
    this.fxInput.connect(this.fxOutput); // bypass by default

    // ---- Stereo phase stage + scope tap ----
    // fxOutput → stereoize(force 2ch) → split → [L | R→delay] → merge → tap → dest
    // A mono source (e.g. a plain sine) is up-mixed so both channels carry it;
    // delaying R then yields a real L/R phase difference (an ellipse/circle on
    // the XY scope). delayR=0 keeps them identical (a 45° line).
    this.phaseStereoize = this.ctx!.createGain();
    this.phaseStereoize.channelCount = 2;
    this.phaseStereoize.channelCountMode = 'explicit';
    this.phaseStereoize.channelInterpretation = 'speakers';

    this.phaseSplitter = this.ctx!.createChannelSplitter(2);
    this.phaseMerger = this.ctx!.createChannelMerger(2);
    this.phaseDelayR = this.ctx!.createDelay(0.05); // up to 50 ms
    this.phaseDelayR.delayTime.value = 0;

    this.fxOutput.connect(this.phaseStereoize);
    this.phaseStereoize.connect(this.phaseSplitter);
    this.phaseSplitter.connect(this.phaseMerger, 0, 0);   // L → merger ch0
    this.phaseSplitter.connect(this.phaseDelayR, 1);       // R → delay
    this.phaseDelayR.connect(this.phaseMerger, 0, 1);      // delayed R → merger ch1

    this.scopeTap = this.ctx!.createGain();
    this.phaseMerger.connect(this.scopeTap);
    this.scopeTap.connect(this.ctx!.destination);

    // Split the final output for the live XY scope (separate L / R analysers).
    const scopeSplitter = this.ctx!.createChannelSplitter(2);
    this.scopeTap.connect(scopeSplitter);
    this.scopeAnalyserL = this.ctx!.createAnalyser();
    this.scopeAnalyserR = this.ctx!.createAnalyser();
    this.scopeAnalyserL.fftSize = 2048;
    this.scopeAnalyserR.fftSize = 2048;
    scopeSplitter.connect(this.scopeAnalyserL, 0);
    scopeSplitter.connect(this.scopeAnalyserR, 1);

    // Filter
    this.filter = this.ctx!.createBiquadFilter();
    this.filter!.type = 'lowpass';
    this.filter!.frequency.value = this.params.cutoff;
    this.filter!.Q.value = this.params.resonance;

    // Delay
    this.delayNode = this.ctx!.createDelay(1.0);
    this.delayNode.delayTime.value = this.params.delayTime;

    this.delayFeedback = this.ctx!.createGain();
    this.delayFeedback.gain.value = this.params.delayFeedback;

    this.delayWet = this.ctx!.createGain();
    this.delayWet.gain.value = 0.5;

    // Routing: filter → master + filter → delay → feedback → delay, delay → wet → master
    this.filter!.connect(this.masterGain!);
    this.filter!.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.delayWet.connect(this.masterGain!);

    this.isInitialized = true;
    console.log(`AudioEngine initialized (sampleRate: ${this.ctx!.sampleRate} Hz)`);
  }

  // Rebuild AudioContext with new sample rate
  async reinit(sampleRate?: number | null) {
    if (sampleRate !== undefined) this.sampleRate = sampleRate;

    // Stop and close old context
    if (this.ctx) {
      try { await this.ctx!.close(); } catch(e) {}
    }

    // Reset state
    this.isInitialized = false;
    this.osc = null;
    this.oscGain = null;

    // Reinit effects engine nodes (mark as not ready so they rebuild)
    if (effectsEngine) {
      effectsEngine.audioNodesReady = false;
    }

    // Rebuild audio context
    await this.init();

    // Rebuild effects nodes
    if (effectsEngine) {
      effectsEngine.initAudioNodes();
    }

    console.log(`AudioEngine reinitialized (sampleRate: ${this.ctx!.sampleRate} Hz)`);
  }

  resume() {
    if (this.ctx && this.ctx!.state === 'suspended') {
      this.ctx!.resume();
    }
  }

  // ===== SYNTH =====

  playNote(noteName: string, duration: number | null = null) {
    if (!this.isInitialized) return;

    const freq = this.getNoteFreq(noteName);
    if (!freq) return;
    this.currentPitchHz = freq;

    const now = this.ctx!.currentTime;
    const { envAttack, envDecay, envSustain, envRelease, synthVol } = this.params;
    const totalDur = envAttack + envDecay + envRelease + 0.05;

    // Oscillator（'drawing' は playFreqWithDrawing 経由で扱うため、ここは実 OscillatorType のみ）
    const osc = this.ctx!.createOscillator();
    osc.type = this.params.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);

    // ADSR Envelope
    const envGain = this.ctx!.createGain();
    envGain.gain.setValueAtTime(0.001, now);
    envGain.gain.linearRampToValueAtTime(synthVol, now + envAttack);
    envGain.gain.linearRampToValueAtTime(synthVol * envSustain, now + envAttack + envDecay);
    envGain.gain.linearRampToValueAtTime(0.001, now + envAttack + envDecay + envRelease);

    osc.connect(envGain);
    envGain.connect(this.filter!);

    osc.start(now);
    osc.stop(now + totalDur);

    osc.onended = () => {
      osc.disconnect();
      envGain.disconnect();
    };

    return osc;
  }

  playFreq(freq: number) {
    if (!this.isInitialized) return;
    this.currentPitchHz = freq;

    const now = this.ctx!.currentTime;
    const { envAttack, envDecay, envSustain, envRelease, synthVol } = this.params;
    const totalDur = envAttack + envDecay + envRelease + 0.05;

    const osc = this.ctx!.createOscillator();
    osc.type = this.params.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);

    const envGain = this.ctx!.createGain();
    envGain.gain.setValueAtTime(0.001, now);
    envGain.gain.linearRampToValueAtTime(synthVol, now + envAttack);
    envGain.gain.linearRampToValueAtTime(synthVol * envSustain, now + envAttack + envDecay);
    envGain.gain.linearRampToValueAtTime(0.001, now + envAttack + envDecay + envRelease);

    osc.connect(envGain);
    envGain.connect(this.filter!);

    osc.start(now);
    osc.stop(now + totalDur);

    osc.onended = () => {
      osc.disconnect();
      envGain.disconnect();
    };
  }

  getNoteFreq(noteName: string): number | null {
    const baseFreq = this.noteFreqs[noteName];
    if (!baseFreq) return null;
    return baseFreq * this.octaveMultipliers[this.params.octave];
  }

  // Play a frequency using Drawing waveform (stereo: L=waveX, R=waveY)
  // This preserves L/R separation for Lissajous/XY oscilloscope display
  playFreqWithDrawing(freq: number, waveX: ArrayLike<number>, waveY?: ArrayLike<number>) {
    if (!this.isInitialized) return;
    if (!waveX || waveX.length === 0) return;
    this.currentPitchHz = freq;

    const now = this.ctx!.currentTime;
    const bufferLength = waveX.length;

    // Create stereo buffer: L=waveX, R=waveY
    const buffer = this.ctx!.createBuffer(2, bufferLength, this.ctx!.sampleRate);
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < bufferLength; i++) {
      lData[i] = waveX[i] || 0;
      rData[i] = (waveY && waveY[i]) ? waveY[i] : (waveX[i] || 0);
    }

    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    // Frequency control via playbackRate
    // Base frequency = sampleRate / bufferLength
    const baseFreq = this.ctx!.sampleRate / bufferLength;
    source.playbackRate.value = freq / baseFreq;

    // ADSR Envelope
    const { envAttack, envDecay, envSustain, envRelease, synthVol } = this.params;
    const totalDur = envAttack + envDecay + envRelease + 0.05;

    const envGain = this.ctx!.createGain();
    envGain.gain.setValueAtTime(0.001, now);
    envGain.gain.linearRampToValueAtTime(synthVol, now + envAttack);
    envGain.gain.linearRampToValueAtTime(synthVol * envSustain, now + envAttack + envDecay);
    envGain.gain.linearRampToValueAtTime(0.001, now + envAttack + envDecay + envRelease);

    source.connect(envGain);
    envGain.connect(this.filter!);

    source.start(now);
    source.stop(now + totalDur);

    source.onended = () => {
      source.disconnect();
      envGain.disconnect();
    };
  }

  // ===== PARAMETER SETTERS =====

  setParam(name: string, value: any) {
    (this.params as any)[name] = value;

    switch (name) {
      case 'masterVol':
        // Glide instead of jumping the gain — a hard `.value =` write steps the
        // signal by one sample and produces an audible click/zipper noise.
        if (this.masterGain) this.masterGain!.gain.setTargetAtTime(value, this.ctx!.currentTime, 0.015);
        break;
      case 'cutoff':
        if (this.filter) this.filter!.frequency.setTargetAtTime(value, this.ctx!.currentTime, 0.01);
        break;
      case 'resonance':
        if (this.filter) this.filter!.Q.setTargetAtTime(value, this.ctx!.currentTime, 0.01);
        break;
      case 'delayTime':
        if (this.delayNode) this.delayNode.delayTime.value = value;
        break;
      case 'delayFeedback':
        if (this.delayFeedback) this.delayFeedback.gain.value = value;
        break;
      case 'waveType':
        // Applied on next note
        break;
    }
  }

  // ===== PRESET STATE (Serializable) =====

  readonly stateKey = 'audioEngine';

  getState() {
    return { params: { ...this.params } };
  }

  setState(state: any) {
    if (!state || !state.params) return;
    Object.entries(state.params).forEach(([key, value]) => {
      // Set param state directly so UI and audio stay in sync.
      (this.params as any)[key] = value;
    });
    // Re-apply node-backed params (gain/filter/delay) from the restored values.
    ['masterVol', 'cutoff', 'resonance', 'delayTime', 'delayFeedback'].forEach(k => {
      this.setParam(k, (this.params as any)[k]);
    });
    // Fire updates so UI components reflect the new values.
    this.syncParamUIDom();
    // Notify param-control based UI (knobs / readouts / BPM) to re-render.
    emit('params:changed');
  }

  // Sync `.param-slider` DOM values from `this.params`.
  syncParamUIDom() {
    const sliders = document.querySelectorAll<HTMLInputElement>('.param-slider');
    sliders.forEach(slider => {
      const pName = slider.dataset.param;
      if (pName && (this.params as any)[pName] !== undefined) {
        slider.value = String((this.params as any)[pName]);
        // Manually trigger the 'input' event to update labels and logic.
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
}

export const audioEngine = new AudioEngine();
registerSerializable(audioEngine);
