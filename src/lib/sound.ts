'use client';

/**
 * The Phase 1 arrival chime — SRS §3.
 *
 * Synthesised with the Web Audio API rather than shipped as an audio file: two
 * short tones need no asset, no network request, and no licence.
 *
 * Browsers refuse to start an AudioContext before the user has interacted with
 * the page. Rather than fail silently, the generator stays lazy and the caller
 * may re-use the same context across calls.
 */

let context: AudioContext | null = null;

type AudioContextConstructor = new () => AudioContext;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;

  if (!Ctor) {
    return null;
  }

  if (!context) {
    context = new Ctor();
  }
  if (context.state === 'suspended') {
    void context.resume();
  }
  return context;
}

function tone(audio: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;

  // Fade in and out to avoid the click a hard gain change produces.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.18, startAt + 0.015);
  gain.gain.linearRampToValueAtTime(0, startAt + duration);

  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** Plays the two-note "a new pre-order arrived" chime. */
export function playPreOrderChime(): void {
  const audio = getContext();
  if (!audio) {
    return;
  }

  const now = audio.currentTime;
  tone(audio, 880, now, 0.14);
  tone(audio, 1174.66, now + 0.16, 0.2);
}

/** Plays the lower "something needs attention" tone. */
export function playWarningChime(): void {
  const audio = getContext();
  if (!audio) {
    return;
  }

  const now = audio.currentTime;
  tone(audio, 523.25, now, 0.18);
  tone(audio, 392, now + 0.2, 0.26);
}

/** Unlocks audio playback, to be called from a user gesture. */
export function primeAudio(): void {
  getContext();
}
