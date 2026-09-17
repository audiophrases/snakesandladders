import assert from 'node:assert/strict';
import test from 'node:test';
import { createSoundPlayer } from './sound.js';

function audioFixture(initialState = 'running') {
  const contexts = [];
  class AudioContext {
    constructor() {
      this.state = initialState;
      this.currentTime = 10;
      this.destination = {};
      this.oscillators = [];
      this.resumeCalls = 0;
      contexts.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
    createOscillator() {
      const oscillator = {
        frequency: { value: 0 },
        stops: [],
        connected: false,
        connect() { this.connected = true; },
        disconnect() { this.connected = false; },
        start(time) { this.startTime = time; },
        stop(time) { this.stops.push(time); },
      };
      this.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    }
  }
  return { contexts, AudioContext, player: createSoundPlayer(AudioContext) };
}

test('muted and unsupported audio do not start playback', () => {
  const { player, contexts } = audioFixture();
  player.setEnabled(false);
  player.play('roll');
  player.beep(500, 100);
  assert.equal(contexts.length, 0);
  assert.doesNotThrow(() => createSoundPlayer(null).play('roll'));
});

test('mute stops both sounding and future notes; unmute does not revive them', () => {
  const { player, contexts } = audioFixture();
  player.play('roll');
  const notes = [...contexts[0].oscillators];
  assert.ok(notes.some((note) => note.startTime > contexts[0].currentTime));
  player.setEnabled(false);
  assert.ok(notes.every((note) => !note.connected && note.stops.at(-1) === undefined));
  player.setEnabled(true);
  player.play('success');
  assert.ok(notes.every((note) => !note.connected));
  assert.ok(contexts[0].oscillators.at(-1).connected);
});

test('suspended and interrupted audio resume before scheduling', async () => {
  for (const state of ['suspended', 'interrupted']) {
    const { player, contexts } = audioFixture(state);
    assert.equal(player.play('success'), undefined);
    assert.equal(contexts[0].resumeCalls, 1);
    await Promise.resolve();
    assert.ok(contexts[0].oscillators.length > 0);
  }
});

test('a pending resume never holds up the caller and only plays the latest request', async () => {
  const { player, contexts, AudioContext } = audioFixture('suspended');
  let finishResume;
  const pending = new Promise((resolve) => { finishResume = resolve; });
  AudioContext.prototype.resume = () => pending;
  assert.equal(player.play('roll'), undefined);
  assert.equal(player.play('fail'), undefined);
  assert.equal(contexts[0].oscillators.length, 0);
  contexts[0].state = 'running';
  finishResume();
  await pending;
  assert.deepEqual(contexts[0].oscillators.map((note) => note.frequency.value), [260]);
});

test('muting cancels a pending resume even if sound is enabled again', async () => {
  const { player, contexts, AudioContext } = audioFixture('suspended');
  let finishResume;
  const pending = new Promise((resolve) => { finishResume = resolve; });
  AudioContext.prototype.resume = () => pending;
  player.play('roll');
  player.setEnabled(false);
  player.setEnabled(true);
  contexts[0].state = 'running';
  finishResume();
  await pending;
  assert.equal(contexts[0].oscillators.length, 0);
});

test('rejected resume is contained and a later interaction retries', async () => {
  const { player, contexts, AudioContext } = audioFixture('suspended');
  const normalResume = AudioContext.prototype.resume;
  AudioContext.prototype.resume = () => Promise.reject(new Error('Audio blocked'));
  assert.equal(player.play('success'), undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(contexts[0].oscillators.length, 0);
  AudioContext.prototype.resume = normalResume;
  player.play('success');
  await Promise.resolve();
  assert.ok(contexts[0].oscillators.length > 0);
});

test('closed contexts and effect cleanup can be followed by fresh playback', () => {
  const { player, contexts } = audioFixture();
  player.play('success');
  contexts[0].state = 'closed';
  player.play('success');
  assert.equal(contexts.length, 2);
  player.dispose();
  assert.equal(contexts[1].state, 'closed');
  player.play('success');
  assert.equal(contexts.length, 3);
  assert.ok(contexts[2].oscillators.length > 0);
});

test('audio construction and scheduling failures do not escape to gameplay', () => {
  class UnavailableAudio {
    constructor() { throw new Error('Audio unavailable'); }
  }
  assert.doesNotThrow(() => createSoundPlayer(UnavailableAudio).play('roll'));
  const { player, AudioContext } = audioFixture();
  AudioContext.prototype.createGain = () => { throw new Error('Audio unavailable'); };
  assert.doesNotThrow(() => player.play('success'));
});
