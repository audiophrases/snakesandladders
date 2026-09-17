// [start offset in ms, frequency, duration in ms, waveform, volume]
const EFFECTS = {
  roll: [
    [0, 300, 55, 'triangle', 0.035],
    [90, 360, 55, 'triangle', 0.035],
    [195, 330, 55, 'triangle', 0.035],
    [325, 400, 55, 'triangle', 0.035],
    [490, 350, 55, 'triangle', 0.035],
    [700, 430, 55, 'triangle', 0.035],
    [960, 380, 55, 'triangle', 0.035],
    [1280, 450, 55, 'triangle', 0.035],
    [1660, 410, 55, 'triangle', 0.035],
  ],
  land: [[0, 180, 130, 'triangle', 0.05], [0, 520, 70, 'sine', 0.03]],
  success: [[0, 520, 80, 'sine', 0.05], [55, 700, 110, 'sine', 0.05]],
  fail: [[0, 260, 120, 'sawtooth', 0.045]],
  ladder: [[0, 500, 80, 'square', 0.045], [45, 650, 90, 'square', 0.045], [90, 830, 110, 'square', 0.045]],
  snake: [[0, 380, 100, 'sawtooth', 0.04], [35, 260, 130, 'sawtooth', 0.04]],
  win: [[0, 620, 110, 'triangle', 0.05], [40, 780, 110, 'triangle', 0.05], [80, 980, 170, 'triangle', 0.05]],
  freeze: [[0, 410, 80, 'sine', 0.04], [50, 310, 120, 'sine', 0.04]],
};

export function createSoundPlayer(AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext) {
  let context = null;
  let enabled = true;
  let generation = 0;
  let lastRequest = 0;
  const active = new Set();

  const stopNotes = () => {
    generation += 1;
    for (const { oscillator, gain } of active) {
      // Disconnect immediately, including notes scheduled later in a roll.
      oscillator.disconnect();
      gain.disconnect();
      try { oscillator.stop(); } catch { /* The note may have already ended. */ }
    }
    active.clear();
  };

  const playNotes = (notes) => {
    if (!enabled || !AudioContext) return;
    try {
      if (!context || context.state === 'closed') {
        stopNotes();
        context = new AudioContext();
      }
      const ctx = context;
      const version = generation;
      const request = ++lastRequest;
      const schedule = () => {
        if (!enabled || generation !== version || ctx !== context || ctx.state !== 'running') return;
        const now = ctx.currentTime;
        for (const [offset, frequency, ms, type, volume] of notes) {
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          const note = { oscillator, gain };
          active.add(note);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
            active.delete(note);
          };
          oscillator.type = type;
          oscillator.frequency.value = frequency;
          oscillator.connect(gain);
          gain.connect(ctx.destination);

          const start = now + offset / 1000;
          const duration = ms / 1000;
          // A short attack and audible body avoid clicks and barely audible ticks.
          const peak = volume * 4;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(peak, start + 0.005);
          gain.gain.setValueAtTime(peak, start + duration * 0.25);
          gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
          oscillator.start(start);
          oscillator.stop(start + duration);
        }
      };

      if (ctx.state === 'running') {
        schedule();
      } else {
        // Call resume in the click handler, but never make gameplay wait for it.
        // This also recovers interrupted audio after switching apps on mobile.
        void ctx.resume().then(() => {
          if (request === lastRequest) schedule();
        }).catch(() => {
          // Clear partially scheduled notes if audio failed during startup.
          if (ctx === context && generation === version) stopNotes();
        });
      }
    } catch {
      // Unavailable audio must not prevent rolling, moving, or ending a turn.
      stopNotes();
    }
  };

  return {
    play: (kind) => playNotes(EFFECTS[kind] || []),
    beep: (frequency, ms, type = 'sine', volume = 0.04) => playNotes([[0, frequency, ms, type, volume]]),
    setEnabled(value) {
      enabled = value;
      if (!enabled) stopNotes();
    },
    dispose() {
      stopNotes();
      const previous = context;
      context = null;
      if (previous && previous.state !== 'closed') void previous.close().catch(() => {});
    },
  };
}
