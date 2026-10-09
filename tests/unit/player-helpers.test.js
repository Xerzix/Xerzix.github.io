import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renditionClass, heightLabel, qualityOptions, capIndexForHeight, initialQuality, pickProgressiveVariant, autoLabel,
  subtitleStyle, parseCueText, resumePosition, parseTimeParam, playedDelta, clampDelta, creditsAt, inIntro,
  pickAudioTrack, pickSubtitleTrack, formatBitrate, episodeLabel, uaSummary, describeError, partyPosition, needsResync,
  heightBadge, isGenericTrackName, langMatches,
} from '../../js/player/helpers.js';

test('rendition class and labels: 4K only for a 2160-class rendition', () => {
  assert.equal(renditionClass(1920, 1080), 1080);
  assert.equal(renditionClass(1920, 800), 1080, 'scope encodes are labelled by width');
  assert.equal(renditionClass(3840, 1600), 2160);
  assert.equal(renditionClass(1440, 1080), 1080, '4:3 keeps its height');
  assert.equal(renditionClass(1280, 718), 720, 'snaps within 4 %');
  assert.equal(renditionClass(0, 0), 0);
  assert.equal(heightLabel(2160), '4K · 2160p');
  assert.equal(heightLabel(1440), '1440p');
  assert.equal(heightLabel(1080), '1080p');
  assert.equal(heightLabel(0), 'Unknown');
});

test('quality options: dedupe by height, highest bitrate wins, sorted descending, no invented 4K', () => {
  const levels = [
    { width: 640, height: 360, bitrate: 800_000 },
    { width: 1280, height: 720, bitrate: 2_000_000 },
    { width: 1280, height: 720, bitrate: 3_000_000 },
    { width: 1920, height: 1080, bitrate: 5_000_000 },
    { width: 0, height: 0, bitrate: 128_000 }, // audio-only level
  ];
  const opts = qualityOptions(levels);
  assert.deepEqual(opts.map((o) => o.label), ['1080p', '720p', '360p']);
  assert.equal(opts[1].levelIndex, 2);
  assert.ok(!opts.some((o) => o.label.includes('4K')));
  const uhd = qualityOptions([...levels, { width: 3840, height: 2160, bitrate: 16_000_000 }]);
  assert.equal(uhd[0].label, '4K · 2160p');
});

test('data-saver cap and initial quality preferences', () => {
  const levels = [{ height: 360, width: 640, bitrate: 1 }, { height: 480, width: 854, bitrate: 2 }, { height: 1080, width: 1920, bitrate: 3 }];
  assert.equal(capIndexForHeight(levels, 480), 1);
  assert.equal(capIndexForHeight([{ height: 720, width: 1280 }, { height: 1080, width: 1920 }], 480), 0, 'falls back to the lowest level');
  assert.equal(capIndexForHeight(levels, null), -1);
  const opts = qualityOptions(levels);
  assert.deepEqual(initialQuality({ defaultQuality: 'auto' }, opts), { mode: 'auto' });
  assert.deepEqual(initialQuality({ defaultQuality: 'data-saver' }, opts), { mode: 'auto', capHeight: 480 });
  assert.deepEqual(initialQuality({ defaultQuality: 'auto', dataSaver: true }, opts), { mode: 'auto', capHeight: 480 });
  assert.deepEqual(initialQuality({ defaultQuality: 'highest' }, opts), { mode: 'manual', height: 1080 });
  assert.equal(autoLabel(1080), 'Auto · 1080p');
  assert.equal(autoLabel(null), 'Auto');
  assert.equal(autoLabel(360, { capped: true }), 'Auto (Data saver) · 360p');
  const variants = [{ height: 360, src: 'a' }, { height: 720, src: 'b' }, { height: 1080, src: 'c' }];
  assert.equal(pickProgressiveVariant(variants, { defaultQuality: 'data-saver' }).height, 360);
  assert.equal(pickProgressiveVariant(variants, { defaultQuality: 'highest' }).height, 1080);
  assert.equal(pickProgressiveVariant(variants, {}, 'b').height, 720);
});

test('subtitle style is normalised and never passes through unsafe values', () => {
  assert.deepEqual(subtitleStyle({ size: 'large', color: '#ffe27a', background: 'box', position: 'top' }).vars, { '--sub-scale': '1.28', '--sub-color': '#FFE27A' });
  const bad = subtitleStyle({ size: 'huge', color: 'red; background:url(x)', background: 'neon', position: 'left' });
  assert.equal(bad.size, 'medium');
  assert.equal(bad.color, '#F8F5F2');
  assert.equal(bad.background, 'shadow');
  assert.equal(bad.position, 'bottom');
});

test('cue text is parsed into styled text segments, never HTML', () => {
  assert.deepEqual(parseCueText('<i>Hi</i> &amp; bye\nnext'), [
    [{ text: 'Hi', bold: false, italic: true, underline: false, voice: null }, { text: ' & bye', bold: false, italic: false, underline: false, voice: null }],
    [{ text: 'next', bold: false, italic: false, underline: false, voice: null }],
  ]);
  const v = parseCueText('<v Aiko>Look</v> <script>x</script><ruby>漢<rt>kan</rt></ruby>');
  assert.equal(v[0][0].voice, 'Aiko');
  assert.equal(v[0].map((s) => s.text).join(''), 'Look x漢');
  assert.deepEqual(parseCueText('&lt;b&gt;').flat().map((s) => s.text), ['<b>']);
});

test('resume rules: after 15 s and before 95 %', () => {
  assert.equal(resumePosition(10, 600), null);
  assert.equal(resumePosition(15, 600), null);
  assert.equal(resumePosition(16, 600), 16);
  assert.equal(resumePosition(570, 600), null);
  assert.equal(resumePosition(569, 600), 569);
  assert.equal(resumePosition(300, null), 300, 'unknown duration resumes tentatively');
  assert.equal(parseTimeParam('754'), 754);
  assert.equal(parseTimeParam('12:34'), 754);
  assert.equal(parseTimeParam('1:02:03'), 3723);
  assert.equal(parseTimeParam('abc'), null);
});

test('watched time counts only real playback', () => {
  assert.equal(playedDelta(10, 10.25), 0.25);
  assert.equal(playedDelta(10, 40), 0, 'a seek is not watching');
  assert.equal(playedDelta(10, 9), 0);
  assert.equal(playedDelta(10, 14, 2), 4, 'fast playback allows larger steps');
  assert.equal(clampDelta(500), 120);
  assert.equal(clampDelta(-3), 0);
});

test('intro and credits markers', () => {
  assert.equal(creditsAt({ creditsStart: 1300 }, 1400), 1300);
  assert.equal(creditsAt({}, 3600), 3580);
  assert.equal(creditsAt({}, 20), 17);
  assert.equal(creditsAt({}, NaN), null);
  assert.equal(inIntro(12, { introStart: 5, introEnd: 40 }), true);
  assert.equal(inIntro(39.8, { introStart: 5, introEnd: 40 }), false);
  assert.equal(inIntro(12, {}), false);
});

test('track selection follows profile languages', () => {
  const audio = [{ lang: 'en', default: true }, { lang: 'ja' }, { lang: 'es-MX' }];
  assert.equal(pickAudioTrack(audio, { preferred: 'ja' }), 1);
  assert.equal(pickAudioTrack(audio, { preferred: 'es' }), 2);
  assert.equal(pickAudioTrack(audio, { preferred: 'fr' }), 0);
  assert.equal(pickAudioTrack([], {}), -1);
  const subs = [{ lang: 'en', kind: 'captions' }, { lang: 'en', kind: 'subtitles' }, { lang: 'ja', kind: 'subtitles' }];
  assert.equal(pickSubtitleTrack(subs, { subtitlesDefault: false, subtitleLanguage: 'en' }), -1);
  assert.equal(pickSubtitleTrack(subs, { subtitlesDefault: true, subtitleLanguage: 'en' }), 1);
  assert.equal(pickSubtitleTrack(subs, { subtitlesDefault: true, uiLanguage: 'ja' }), 2);
  assert.equal(pickSubtitleTrack(subs, { subtitlesDefault: true, subtitleLanguage: 'de', uiLanguage: 'fr' }), -1);
});

test('track names: packager placeholders are recognised, real names and languages are kept', () => {
  for (const generic of ['audio_0', 'Audio 2', 'track-1', 'stereo', 'Main', 'und', '3']) assert.equal(isGenericTrackName(generic), true, generic);
  for (const real of ['English', '日本語', 'Original score (no dialogue)', 'Director commentary', 'Audio description']) assert.equal(isGenericTrackName(real), false, real);
  assert.equal(langMatches('en-GB', 'en'), true);
  assert.equal(langMatches('ja', 'JA-jp'), true);
  assert.equal(langMatches('en', 'ja'), false);
  assert.equal(langMatches('', 'en'), false);
});

test('formatting and device summary', () => {
  assert.equal(heightBadge(2160), '4K');
  assert.equal(heightBadge(1080), 'HD');
  assert.equal(heightBadge(480), 'SD');
  assert.equal(heightBadge(0), '');
  assert.equal(formatBitrate(2_450_000), '2.5 Mbps');
  assert.equal(formatBitrate(850_000), '850 kbps');
  assert.equal(formatBitrate(0), '—');
  assert.equal(episodeLabel({ seasonNumber: 1, number: 2, name: 'Moonrise' }), 'S1:E2 · Moonrise');
  assert.equal(uaSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'), 'Chrome 140 on macOS');
  assert.equal(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18 on iOS');
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox 131 on Windows');
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), 'Edge 140 on Windows');
});

test('error wording covers every failure type', () => {
  for (const kind of ['network', 'decode', 'unsupported', 'dash', 'source_unavailable', 'stalled', 'ENTITLEMENT_REQUIRED', 'MEDIA_UNAVAILABLE', 'PROFILE_RESTRICTED']) {
    const d = describeError(kind);
    assert.ok(d.title && d.message, kind);
  }
  assert.match(describeError('dash').message, /DASH playback is not enabled/);
  assert.equal(describeError('PROFILE_RESTRICTED').retry, false);
});

test('party timeline extrapolation and drift threshold', () => {
  const state = { playing: true, position: 100, updatedAt: new Date(10_000).toISOString() };
  assert.equal(partyPosition(state, 13_000), 103);
  assert.equal(partyPosition(state, 13_000, 1000), 104, 'server clock ahead by 1 s');
  assert.equal(partyPosition({ ...state, playing: false }, 99_000), 100);
  assert.equal(needsResync(100, 101.4), false);
  assert.equal(needsResync(100, 101.6), true);
});
