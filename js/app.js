/**
 * DLOSy20 - Main Application
 * Initializes all modules and handles global state
 */

// ===== Module imports =====
// 各モジュールはインスタンスを named export しており、ここで明示的に import する。
// これにより依存関係が import 文として確定する（旧来の window グローバル方式を廃止）。
import { audioEngine } from './audio-engine';
import { uiComponents } from './ui-components';
import { transportClock } from './transport-clock';
import { vcoLoop } from './vco-loop';
import { drawingMode } from './drawing-mode';
import { unimSearch } from './unim-search';
import { effectsEngine } from './effects-engine';
import { cvClock } from './cv-clock';
import { midiIn } from './midi-in';
import { presetManager } from './preset-manager';
import { audioSettings } from './audio-settings';
import { arpeggiator } from './arpeggiator';
import { vcoEase } from './vco-ease';
import { panelLayout } from './panel-layout';

document.addEventListener('DOMContentLoaded', () => {
  console.log('DLOSy20 Web Synthesizer - Initializing...');

  // Initialize UI Components (knobs, transport key)
  uiComponents.init();

  // Initialize Transport Clock (Play/Stop → VCO Loop + Drawing Mode)
  transportClock.init();

  // Initialize VCO Loop
  vcoLoop.init();

  // Initialize Drawing Mode
  drawingMode.init();

  // Initialize Unim Search
  if (unimSearch) {
    unimSearch.init();
  }

  // Initialize Effects Engine
  if (effectsEngine) {
    effectsEngine.init();
  }

  // Initialize CV Clock Sync
  if (cvClock) {
    cvClock.init();
  }

  // Initialize MIDI IN
  if (midiIn) {
    midiIn.init();
  }

  // Initialize Preset Manager (save/load)
  if (presetManager) {
    presetManager.init();
  }

  // Initialize Audio Settings
  if (audioSettings) {
    audioSettings.init();
  }

  // Initialize Arpeggiator
  if (arpeggiator) {
    arpeggiator.init();
  }

  // Initialize VCO Loop Easing
  if (vcoEase) {
    vcoEase.init();
  }

  // Initialize Panel Layout (drag-to-resize / drag-to-reorder)
  if (panelLayout) {
    panelLayout.init();
  }

  // ===== Center panel tab switching =====
  function onCenterTabSwitch(target) {
    // Update center tab buttons
    document.querySelectorAll('.center-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.center-tab-content').forEach(c => c.classList.remove('active'));
    const tabBtn = document.querySelector(`.center-tab[data-tab="${target}"]`);
    const content = document.getElementById(`center-tab-${target}`);
    if (tabBtn) tabBtn.classList.add('active');
    if (content) content.classList.add('active');

    // Redraw ARP ADSR canvas after tab becomes visible (resize sync)
    if (arpeggiator && target === 'arp') {
      requestAnimationFrame(() => {
        if (arpeggiator.drawAdsrCurve) arpeggiator.drawAdsrCurve();
      });
    }

    // Redraw Easing canvas after tab becomes visible (resize sync)
    if (vcoEase && target === 'ease') {
      requestAnimationFrame(() => {
        vcoEase.syncCanvasSize();
        vcoEase.draw();
      });
    }
  }

  document.querySelectorAll('.center-tab').forEach(tab => {
    tab.addEventListener('click', () => onCenterTabSwitch(tab.dataset.tab));
  });

  // ===== Track Active Panel (Center vs VCO Loop vs Drawing Mode) =====
  let isVcoActive = false;
  let isDrawingActive = false;
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#vco-loop-panel')) {
      isVcoActive = true;
      isDrawingActive = false;
    } else if (e.target.closest('#drawing-panel')) {
      isDrawingActive = true;
      isVcoActive = false;
    } else if (e.target.closest('#panel-center')) {
      isVcoActive = false;
      isDrawingActive = false;
    }
  });

  // Tab key: cycle Center tabs / VCO LOOP params / Drawing Mode slots
  // 1-8 keys: switch pattern bank if VCO LOOP / Drawing Mode active
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;

    // Handle 1-8 keys for pattern/slot switching
    if (e.key >= '1' && e.key <= '8') {
      const idx = parseInt(e.key, 10) - 1;
      if (isVcoActive && vcoLoop) {
        e.preventDefault();
        vcoLoop.switchPattern(idx);
      } else if (isDrawingActive && drawingMode) {
        e.preventDefault();
        drawingMode.switchPattern(idx);
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();

      if (isDrawingActive && drawingMode) {
        // Cycle Drawing Mode slots
        const nextSlot = (drawingMode.activeSlot + 1) % drawingMode.visibleSlotCount;
        drawingMode.switchSlot(nextSlot);
      } else if (isVcoActive && vcoLoop) {
        // Cycle VCO LOOP parameter tabs
        const params = ['frequency', 'cutoff', 'resonance', 'volume', 'adsr'];
        let activeIdx = params.indexOf(vcoLoop.activeParam);

        // Find next valid tab
        let nextIdx = (activeIdx + 1) % params.length;
        if (vcoLoop.continuousMode && params[nextIdx] === 'adsr') {
           nextIdx = (nextIdx + 1) % params.length; // skip ADSR if in CONT mode
        }

        vcoLoop.switchParam(params[nextIdx]);
      } else {
        // Cycle Center tabs
        const tabs = document.querySelectorAll('.center-tab');
        let activeIdx = 0;
        tabs.forEach((t, i) => { if (t.classList.contains('active')) activeIdx = i; });
        const nextIdx = (activeIdx + 1) % tabs.length;
        onCenterTabSwitch(tabs[nextIdx].dataset.tab);
      }
    }
  });

  // Initialize left panel state based on initial center tab
  const initialCenterTab = document.querySelector('.center-tab.active');
  if (initialCenterTab) {
    onCenterTabSwitch(initialCenterTab.dataset.tab);
  }

  // First click / touch to init audio context
  const initAudio = async () => {
    // Load saved sample rate + latency mode from localStorage
    let savedSr = 48000;
    let savedLatency = 'interactive';
    try {
      const raw = localStorage.getItem('dlosy20_audio_settings');
      if (raw) {
        const saved = JSON.parse(raw);
        const srVal = parseInt(saved.sampleRate, 10);
        if (!isNaN(srVal)) savedSr = srVal || null; // 0 = OS default → null
        if (saved.latencyHint) savedLatency = saved.latencyHint;
      }
    } catch(e) {}

    await audioEngine.init(savedSr, savedLatency);
    audioEngine.resume();
    // Re-apply previously selected output device (a fresh AudioContext
    // always starts on the OS default device until setSinkId runs again)
    if (audioSettings) {
      await audioSettings.applySinkId();
    }
    // Initialize effects audio nodes after audio context is ready
    if (effectsEngine) {
      effectsEngine.initAudioNodes();
    }
    document.removeEventListener('click', initAudio);
    document.removeEventListener('touchstart', initAudio);
    console.log('Audio context started');
  };

  document.addEventListener('click', initAudio, { once: true });
  document.addEventListener('touchstart', initAudio, { once: true });


  // Resume AudioContext when tab becomes visible again (browser may suspend it in background)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioEngine) {
      audioEngine.resume();
    }
  });

  console.log('DLOSy20 ready - click or tap to enable audio');
});
