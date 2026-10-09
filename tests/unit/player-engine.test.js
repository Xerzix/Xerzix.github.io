// hls.js engine: the bitrate sent as telemetry is measured from downloaded segments, never the
// playlist's declared BANDWIDTH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlsJsEngine } from '../../js/player/engine.js';

class FakeHls {
  static Events = {
    MANIFEST_PARSED: 'manifestParsed', LEVEL_SWITCHED: 'levelSwitched', AUDIO_TRACKS_UPDATED: 'audioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'audioTrackSwitched', SUBTITLE_TRACKS_UPDATED: 'subtitleTracksUpdated', FRAG_LOADED: 'fragLoaded', ERROR: 'error',
  };

  constructor(config) {
    this.config = config;
    this.handlers = {};
    // Declared peak BANDWIDTH per level, as hls.js exposes it.
    this.levels = [{ height: 1080, bitrate: 280_000 }, { height: 360, bitrate: 140_000 }];
    this.currentLevel = 0;
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  attachMedia() {}
  loadSource() {}
  fire(event, data) { for (const fn of this.handlers[event] || []) fn(event, data); }
}

const fragment = (level, bytes, duration, type = 'main') => ({ frag: { type, level, duration, stats: { loaded: bytes } } });

test('playingBitrate is measured from the current level’s downloaded segments, not declared', () => {
  const video = { videoWidth: 0, videoHeight: 0 };
  const engine = new HlsJsEngine(video, { src: '/media/x/master.m3u8' }, FakeHls, {});
  engine.start();
  const hls = engine.hls;
  assert.equal(engine.playingBitrate(), null, 'nothing measured yet');
  assert.equal(engine.currentBitrate(), 280_000, 'declared value stays available for Stats for nerds');

  // Two 4 s segments of 1080p at 21 000 bytes each: 42 000 × 8 / 8 s = 42 000 bit/s.
  hls.fire('fragLoaded', fragment(0, 21_000, 4));
  hls.fire('fragLoaded', fragment(0, 21_000, 4));
  // Other renditions and audio segments do not count towards the 1080p figure.
  hls.fire('fragLoaded', fragment(1, 9_000, 4));
  hls.fire('fragLoaded', fragment(0, 50_000, 4, 'audio'));
  assert.equal(engine.playingBitrate(), 42_000);
  assert.notEqual(engine.playingBitrate(), engine.currentBitrate());

  hls.currentLevel = 1;
  assert.equal(engine.playingBitrate(), 18_000);
  hls.currentLevel = -1; // not known yet
  assert.equal(engine.playingBitrate(), null);
});
