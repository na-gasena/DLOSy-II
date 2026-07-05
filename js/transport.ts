/**
 * DLOSy20 - Shared transport / live playback state
 *
 * A passive, dependency-free state holder. The transport clock writes its play
 * position here; the VCO loop writes its live phase here. Other modules READ
 * from it instead of importing each other, which breaks the
 * transport-clock ⇄ vco-loop and vco-loop ⇄ vco-ease import cycles.
 *
 * Nothing in this file imports anything — that is the whole point: it sits at
 * the bottom of the dependency graph so every module can depend on it acyclically.
 */
export const transport = {
  // --- Transport (written by transport-clock, read by vco-loop) ---
  isPlaying: false,
  currentStep: 0,
  numSteps: 16,

  // --- VCO loop live phase (written by vco-loop, read by vco-ease) ---
  vcoRunning: false,
  vcoStepIndex: 0,
  vcoTotalSteps: 16,
  vcoStepStartTime: 0,
  vcoStepDuration: 0,
  vcoContinuous: false,
};
