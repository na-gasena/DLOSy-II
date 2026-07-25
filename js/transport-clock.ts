/**
 * DLOSy20 - Transport Clock
 *
 * The master play/stop clock. Drives VCO Loop and Drawing Mode by advancing a
 * fixed-length step grid and fanning each step tick out to them.
 *
 * This used to live inside the Step Sequencer, which also played notes and
 * triggered drums. The note sequencer + drum machine were removed; this lean
 * transport is what remains so VCO Loop / Drawing Mode keep their playback clock
 * (Play button, lookahead scheduler, external MIDI-clock sync).
 *
 * Live position (isPlaying / currentStep / numSteps) is shared through the
 * dependency-free `transport` module so vco-loop can read it without importing
 * this file (avoids an import cycle).
 */
import { audioEngine } from './audio-engine';
import { vcoLoop } from './vco-loop';
import { drawingMode } from './drawing-mode';
import { cvClock } from './cv-clock';
import { transport } from './transport';

class TransportClock {
  get numSteps(): number { return transport.numSteps; }
  set numSteps(v: number) { transport.numSteps = v; }
  get currentStep(): number { return transport.currentStep; }
  set currentStep(v: number) { transport.currentStep = v; }
  get isPlaying(): boolean { return transport.isPlaying; }
  set isPlaying(v: boolean) { transport.isPlaying = v; }

  _nextStepTime: number = 0;
  _lookaheadId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.numSteps = 16;
    this.currentStep = 0;
    this.isPlaying = false;
  }

  init() {
    // Restore the saved loop length (STEP count) chosen in the VCO editor.
    try {
      const saved = parseInt(localStorage.getItem('dlosy20_numSteps') || '', 10);
      if (saved >= 1 && saved <= 16) this.numSteps = saved;
    } catch (e) {}

    document.getElementById('btn-play')?.addEventListener('click', () => {
      audioEngine.resume();
      audioEngine.init().then(() => this.togglePlay());
    });
  }

  togglePlay() {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }

  play() {
    this.isPlaying = true;
    this.currentStep = 0;

    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
      playBtn.classList.add('playing');
      const icon = playBtn.querySelector('.play-icon');
      if (icon) icon.textContent = '■';
    }

    // Sync: start VCO Loop oscillators
    if (vcoLoop) vcoLoop.onPlayStart();

    // MIDI CLK sync: don't start internal scheduler, wait for MIDI Start/Clock
    if (cvClock && cvClock.enabled) return;

    // Internal mode: lookahead scheduler
    this._nextStepTime = audioEngine.ctx!.currentTime;
    this._startLookahead();
  }

  stop() {
    this.isPlaying = false;
    this._stopLookahead();

    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
      playBtn.classList.remove('playing');
      const icon = playBtn.querySelector('.play-icon');
      if (icon) icon.textContent = '▶';
    }

    // Sync: stop VCO Loop
    if (vcoLoop) vcoLoop.onPlayStop();
  }

  // --- Lookahead Scheduler ---
  // Uses setInterval (25ms) to check audioContext.currentTime and fires steps at
  // the correct audio-clock moment.
  _startLookahead() {
    this._stopLookahead();
    const LOOKAHEAD_MS = 25; // how often to check (ms)

    this._lookaheadId = setInterval(() => {
      if (!this.isPlaying) return;

      // MIDI CLK sync: do not self-schedule
      if (cvClock && cvClock.enabled) return;

      // Extend lookahead when in background (Chrome throttles setInterval to ~1000ms)
      const SCHEDULE_AHEAD = document.hidden ? 2.0 : 0.05;

      const now = audioEngine.ctx!.currentTime;
      // Prevent burst catch-up if the tab was hidden long enough for nextStepTime
      // to lag far behind
      if (this._nextStepTime < now - 0.5) this._nextStepTime = now;
      while (this._nextStepTime < now + SCHEDULE_AHEAD) {
        this._fireStep(this._nextStepTime);
        this._advanceStep();
      }
    }, LOOKAHEAD_MS);
  }

  _stopLookahead() {
    if (this._lookaheadId) {
      clearInterval(this._lookaheadId);
      this._lookaheadId = null;
    }
  }

  _fireStep(audioTime: number) {
    // Calculate the performance.now() timestamp for MIDI/audio scheduling
    const now = audioEngine.ctx!.currentTime;
    const perfNow = performance.now();
    const offsetMs = Math.max(0, (audioTime - now) * 1000);
    const midiTimestamp = perfNow + offsetMs;
    this.tick(midiTimestamp);
  }

  _advanceStep() {
    const bpm = audioEngine.params.tempo;
    const stepDuration = 60 / bpm / 4; // seconds per 16th note
    const swing = audioEngine.params.swing || 0;

    let duration = stepDuration;
    if (this.currentStep % 2 === 1) {
      duration += (swing / 100) * stepDuration * 0.5;
    }

    this._nextStepTime += duration;
    this.currentStep = (this.currentStep + 1) % this.numSteps;
  }

  // Called by CVClock on each external MIDI-clock pulse.
  externalTick() {
    if (!this.isPlaying) return;
    this.tick();
    this.currentStep = (this.currentStep + 1) % this.numSteps;
  }

  // Fan the current step out to Drawing Mode + VCO Loop (what the sequencer used
  // to do on each step, minus the removed note/drum triggers).
  tick(midiTimestamp?: number) {
    // Auto-cycle Drawing slots (Draw 1→2→…→8→1); pass the step so LOOP SYNC can
    // restart the drawing cycle on the loop head (step 0).
    if (drawingMode) drawingMode.advanceSlot(this.currentStep);

    // Update VCO Loop playhead and apply parameters
    if (vcoLoop) {
      vcoLoop.onStepTick(this.currentStep, this.numSteps, midiTimestamp);
      vcoLoop.drawCurve();
    }
  }
}

export const transportClock = new TransportClock();
