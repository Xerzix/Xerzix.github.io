// LuminaPlayer — the reusable video player used by the watch page and watch parties.
//
//   const player = new LuminaPlayer({ profile, mode, onBack, onEpisodeRequest, extras });
//   view.append(player.el);
//   await player.load(playback, { startAt });
//   ctx.onDestroy(() => player.destroy());
//
// Honesty rules: the quality menu lists only renditions the stream really has, the audio
// and subtitle menus only tracks that really exist, and measured telemetry is kept apart
// from anything a member reports. See engine.js, subtitles.js and telemetry.js.
import { h, replace } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { clock, languageName } from '../core/format.js';
import { store } from '../core/storage.js';
import { api } from '../api/client.js';
import { setProfile, refreshLibrary } from '../core/session.js';
import { navigate } from '../core/router.js';
import { icon } from '../ui/icons.js';
import { spinner } from '../ui/components.js';
import { createEngine, PlaybackError } from './engine.js';
import { SubtitleManager } from './subtitles.js';
import { Telemetry, ProgressSaver } from './telemetry.js';
import { PlayerMenu, SeekBar, iconButton, playerDialog, playerIcon } from './ui.js';
import * as H from './helpers.js';

const HIDE_AFTER_MS = 3000;
const SAVE_EVERY_MS = 10_000;
const STALL_HINT_MS = 6000;
const STALL_ERROR_MS = 20_000;
const NEXT_COUNTDOWN_S = 10;

const btn = (label, { variant = 'glass', size, iconName, onClick, className, attrs = {} } = {}) => h('button', {
  type: 'button', class: ['lm-btn', `lm-btn--${variant}`, size && `lm-btn--${size}`, className], onClick, ...attrs,
}, iconName ? playerIcon(iconName) : null, h('span', null, label));

export class LuminaPlayer {
  /**
   * @param {object} o
   *   profile           active profile (null when signed out)
   *   mode              'server' | 'static'
   *   onBack()          back button / Escape from the end screen
   *   onEpisodeRequest(episode, {reason})  play another episode (next, drawer, autoplay)
   *   onMediaChange(playback)             after a new playback is loaded
   *   onRetryLoad()     retry when no playback could be fetched at all
   *   fetchTitle()      TitleDetail loader for the episodes drawer
   *   extras            nodes added to the top bar (e.g. "Start watch party")
   *   contained         render inside a container instead of fixed full-viewport
   *   party             { canControl(), isHost(), onControl(action, position) } in watch parties
   */
  constructor(o = {}) {
    this.o = o;
    this.profile = o.profile || null;
    this.mode = o.mode || 'static';
    this.party = o.party || null;
    this.playback = null;
    this.engine = null;
    this.sources = [];
    this.sourceIndex = 0;
    this.loadSeq = 0;
    this.cleanups = [];
    this.menus = {};
    this.dialog = null;
    this.destroyed = false;
    this.showRemaining = !!store.get('player.remaining', false);
    this.statsVisible = false;
    this.pointerFocus = false;
    this.overControls = false;
    this.resetMediaState();
    this.build();
    this.bind();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    // Opt-in handle for debugging and end-to-end tests: localStorage['lumina.debug'] = 'true'.
    if (store.get('debug', false) === true) window.luminaPlayer = this;
    bus.emit('player:active', true);
  }

  resetMediaState() {
    this.started = false;
    this.ended = false;
    this.errorShown = null;
    this.autoplayBlocked = false;
    this.buffering = false;
    this.lastTime = null;
    this.watchT = 0;
    this.progressAt = performance.now();
    this.lastSaveAt = performance.now();
    this.stallHint = false;
    this.introHandled = false;
    this.creditsHandled = false;
    this.nextCard = null;
    this.nextCancelled = false;
    this.endScreenShown = false;
    this.resumeFrom = null;
    this.trackPrefsApplied = false;
    this.audioPrefApplied = false;
  }

  // ───────────────────────────── DOM ─────────────────────────────
  build() {
    const v = h('video', { class: 'lm-player__video', playsinline: true, 'webkit-playsinline': true, preload: 'auto', 'aria-label': 'Video' });
    this.video = v;
    this.subsEl = h('div', { class: 'lm-subs', 'aria-hidden': 'true' });
    this.surface = h('div', { class: 'lm-player__surface', 'aria-hidden': 'true' });
    this.curtain = h('div', { class: 'lm-player__curtain', 'aria-hidden': 'true' });
    this.flashEl = h('div', { class: 'lm-player__flash', 'aria-hidden': 'true' });
    this.rippleL = h('div', { class: 'lm-player__ripple lm-player__ripple--left', 'aria-hidden': 'true' }, icon('back10'), h('span', null, '10 seconds'));
    this.rippleR = h('div', { class: 'lm-player__ripple lm-player__ripple--right', 'aria-hidden': 'true' }, icon('fwd10'), h('span', null, '10 seconds'));
    this.loader = h('div', { class: 'lm-player__loader', hidden: true }, spinner('Buffering'));
    this.stallEl = h('div', { class: 'lm-player__stall', hidden: true });
    this.live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.osd = h('div', { class: 'lm-player__osd', 'aria-hidden': 'true' });

    // Top bar
    this.backBtn = iconButton('arrowLeft', 'Back', () => this.goBack(), { className: 'lm-player__back' });
    this.titleEl = h('h1', { class: 'lm-player__title' }, 'Loading…');
    this.subtitleEl = h('p', { class: 'lm-player__subtitle' });
    this.extrasEl = h('div', { class: 'lm-player__extras' }, ...(this.o.extras || []));
    this.top = h('div', { class: 'lm-player__top lm-player__chrome' }, this.backBtn, h('div', { class: 'lm-player__heading' }, this.titleEl, this.subtitleEl), this.extrasEl);

    // Centre
    this.bigPlay = h('button', { type: 'button', class: 'lm-player__big', 'aria-label': 'Play', onClick: () => this.togglePlay('user') }, icon('play'));
    this.centerBack = iconButton('back10', 'Back 10 seconds', () => this.seekBy(-H.SEEK_STEP_S, 'user'), { className: 'lm-player__center-skip' });
    this.centerFwd = iconButton('fwd10', 'Forward 10 seconds', () => this.seekBy(H.SEEK_STEP_S, 'user'), { className: 'lm-player__center-skip' });
    this.center = h('div', { class: 'lm-player__center lm-player__chrome' }, this.centerBack, this.bigPlay, this.centerFwd);

    // Bottom bar
    this.seek = new SeekBar({
      step: H.SEEK_STEP_S,
      onSeek: (t) => this.seekTo(t, 'user'),
      onScrub: (t) => {
        this.scrubbing = t !== null;
        if (t !== null) this.showControls();
        else this.scheduleHide();
      },
    });
    this.timeBtn = h('button', { type: 'button', class: 'lm-player__time', 'aria-label': 'Show remaining time', onClick: () => this.toggleRemaining() }, '0:00');
    this.playBtn = iconButton('play', 'Play (k)', () => this.togglePlay('user'));
    this.back10Btn = iconButton('back10', 'Back 10 seconds (←)', () => this.seekBy(-H.SEEK_STEP_S, 'user'), { className: 'lm-player__hide-sm' });
    this.fwd10Btn = iconButton('fwd10', 'Forward 10 seconds (→)', () => this.seekBy(H.SEEK_STEP_S, 'user'), { className: 'lm-player__hide-sm' });
    this.muteBtn = iconButton('volume', 'Mute (m)', () => this.toggleMute());
    this.volume = h('input', { type: 'range', class: 'lm-player__volume', min: '0', max: '100', step: '1', value: '100', 'aria-label': 'Volume' });
    this.volume.addEventListener('input', () => this.setVolume(Number(this.volume.value) / 100));
    this.nextBtn = iconButton('skipNext', 'Next episode (n)', () => this.playNext('button'), { attrs: { hidden: true } });
    this.episodesBtn = iconButton('layers', 'Episodes', () => this.openEpisodes(), { attrs: { hidden: true } });
    this.subsBtn = iconButton('subtitles', 'Audio & subtitles', null);
    this.qualityText = h('span', { class: 'lm-player__quality-text' }, 'Auto');
    this.qualityBtn = h('button', { type: 'button', class: 'lm-player__btn lm-player__btn--text', 'aria-label': 'Quality', 'data-tip': 'Quality' }, icon('hd'), this.qualityText);
    this.settingsBtn = iconButton('settings', 'Settings', null);
    this.pipBtn = iconButton('pip', 'Picture in picture (p)', () => this.togglePip(), { attrs: { hidden: !this.pipSupported() } });
    this.fsBtn = iconButton('fullscreen', 'Full screen (f)', () => this.toggleFullscreen());

    this.bottom = h('div', { class: 'lm-player__bottom lm-player__chrome' },
      h('div', { class: 'lm-player__seekrow' }, this.seek.el, this.timeBtn),
      h('div', { class: 'lm-player__bar' },
        h('div', { class: 'lm-player__group' }, this.playBtn, this.back10Btn, this.fwd10Btn,
          h('div', { class: 'lm-player__volgroup' }, this.muteBtn, this.volume)),
        h('div', { class: 'lm-player__group lm-player__group--end' }, this.nextBtn, this.episodesBtn, this.subsBtn, this.qualityBtn, this.settingsBtn, this.pipBtn, this.fsBtn)));

    // Contextual overlays
    this.chips = h('div', { class: 'lm-player__chips' });
    this.skipIntroBtn = btn('Skip intro', { variant: 'glass', size: 'lg', iconName: 'skipNext', className: 'lm-player__skip', onClick: () => this.skipIntro(false), attrs: { hidden: true, 'aria-keyshortcuts': 'S' } });
    this.skipCreditsBtn = btn('Skip credits', { variant: 'glass', size: 'lg', iconName: 'skipNext', className: 'lm-player__skip', onClick: () => this.skipCredits(), attrs: { hidden: true } });
    this.chips.append(this.skipIntroBtn, this.skipCreditsBtn);
    this.resumeChip = h('div', { class: 'lm-player__resume', hidden: true });
    this.endEl = h('div', { class: 'lm-player__end', hidden: true });
    this.errorEl = h('div', { class: 'lm-player__error', hidden: true, role: 'alertdialog', 'aria-modal': 'false' });
    this.statsEl = h('div', { class: 'lm-player__stats', hidden: true, role: 'region', 'aria-label': 'Stats for nerds' });
    this.menuHost = h('div', { class: 'lm-player__menus' });

    this.root = h('div', {
      class: ['lm-player', this.o.contained && 'lm-player--contained'],
      dataset: { state: 'loading', controls: 'visible' },
      role: 'region',
      'aria-label': 'Video player',
    },
    v, this.subsEl, this.surface, this.curtain, this.loader, this.stallEl, this.flashEl, this.rippleL, this.rippleR,
    this.top, this.center, this.resumeChip, this.chips, this.bottom, this.endEl, this.statsEl, this.errorEl, this.menuHost, this.osd, this.live);

    this.subs = new SubtitleManager(v, this.subsEl, {
      onChange: () => this.onTextTracks(),
      onError: (track, wasSelected) => {
        if (wasSelected) this.notify(`Subtitles “${track?.label || 'track'}” could not be loaded`, 'alert');
      },
    });
    this.subs.setStyle(this.subtitlePrefs());

    this.menus.subs = new PlayerMenu({ host: this.menuHost, trigger: this.subsBtn, label: 'Audio and subtitles', build: () => this.subsMenuItems(), onToggle: (open) => this.onMenuToggle(open) });
    this.menus.quality = new PlayerMenu({ host: this.menuHost, trigger: this.qualityBtn, label: 'Quality', build: () => this.qualityMenuItems(), onToggle: (open) => this.onMenuToggle(open) });
    this.menus.settings = new PlayerMenu({ host: this.menuHost, trigger: this.settingsBtn, label: 'Settings', build: () => this.settingsMenuItems(), onToggle: (open) => this.onMenuToggle(open) });

    const saved = store.get('player.volume', { volume: 1, muted: false }) || {};
    v.volume = Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 1;
    v.muted = !!saved.muted;
    this.updateVolumeUi();
    this.el = this.root;
  }

  // ───────────────────────────── Events ─────────────────────────────
  on(target, event, fn, opts) {
    target.addEventListener(event, fn, opts);
    this.cleanups.push(() => target.removeEventListener(event, fn, opts));
  }

  bind() {
    const v = this.video;
    this.on(v, 'play', () => this.updatePlayState());
    this.on(v, 'pause', () => {
      this.updatePlayState();
      if (!v.ended && this.started && !this.errorShown) {
        this.saveProgress('pause')?.then(() => bus.emit('library:changed', { titleId: this.playback?.titleId }));
      }
    });
    this.on(v, 'playing', () => {
      this.started = true;
      this.autoplayBlocked = false;
      this.setBuffering(false);
      this.telemetry?.onPlaying();
      this.revealVideo();
      this.updatePlayState();
    });
    this.on(v, 'waiting', () => {
      this.setBuffering(true);
      if (!v.seeking) this.telemetry?.onStall();
    });
    this.on(v, 'canplay', () => {
      if (v.paused) this.setBuffering(false);
    });
    this.on(v, 'loadeddata', () => this.revealVideo());
    this.on(v, 'seeking', () => this.updateTimeUi());
    this.on(v, 'seeked', () => {
      this.lastTime = v.currentTime;
      if (v.paused || v.readyState >= 3) this.setBuffering(false);
      clearTimeout(this.seekSaveTimer);
      this.seekSaveTimer = setTimeout(() => this.saveProgress('seek'), 1500);
    });
    this.on(v, 'timeupdate', () => this.onTimeUpdate());
    this.on(v, 'progress', () => this.seek.update(v.currentTime, v.buffered));
    this.on(v, 'loadedmetadata', () => this.onDuration());
    this.on(v, 'durationchange', () => this.onDuration());
    this.on(v, 'ended', () => this.onEnded());
    this.on(v, 'volumechange', () => this.updateVolumeUi());
    this.on(v, 'resize', () => this.updateQualityUi());
    this.on(v, 'enterpictureinpicture', () => this.subs.setNativeRendering(true));
    this.on(v, 'leavepictureinpicture', () => this.subs.setNativeRendering(false));
    this.on(v, 'webkitbeginfullscreen', () => this.subs.setNativeRendering(true));
    this.on(v, 'webkitendfullscreen', () => this.subs.setNativeRendering(false));

    this.on(document, 'keydown', (e) => this.onKey(e));
    this.on(document, 'fullscreenchange', () => this.onFullscreenChange());
    this.on(document, 'webkitfullscreenchange', () => this.onFullscreenChange());
    this.on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.saveProgress('hidden');
        this.telemetry?.flush();
      }
    });
    this.on(window, 'pagehide', () => {
      this.saveProgress('pagehide', { keepalive: true });
      this.telemetry?.flush({ keepalive: true });
    });

    const root = this.root;
    this.on(root, 'pointermove', (e) => {
      if (e.pointerType === 'mouse' && (Math.abs(e.movementX) + Math.abs(e.movementY) < 1)) return;
      if (e.pointerType === 'mouse') this.showControls();
    });
    this.on(root, 'pointerdown', (e) => {
      this.pointerFocus = true;
      if (e.pointerType === 'mouse') this.showControls();
    });
    this.on(root, 'focusin', (e) => {
      if (!this.surface.contains(e.target)) this.showControls();
    });
    // Keyboard focus keeps the controls up (see shouldStayVisible); once it leaves them, the
    // usual hide timer starts again.
    this.on(root, 'focusout', () => {
      setTimeout(() => {
        if (!this.destroyed && this.root.dataset.controls === 'visible') this.scheduleHide();
      }, 0);
    });
    this.on(root, 'mouseleave', () => {
      if (!this.video.paused) this.hideControls();
    });
    for (const zone of [this.top, this.bottom, this.menuHost]) {
      this.on(zone, 'pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.overControls = true;
      });
      this.on(zone, 'pointerleave', () => {
        this.overControls = false;
        this.scheduleHide();
      });
    }

    // Mouse: click toggles play, double-click toggles fullscreen.
    // Touch: tap shows/hides the controls, double-tap on either half seeks ±10 s.
    this.on(this.surface, 'click', () => {
      if (this.lastPointerType === 'mouse') this.togglePlay('user');
    });
    this.on(this.surface, 'dblclick', () => {
      if (this.lastPointerType === 'mouse') this.toggleFullscreen();
    });
    this.on(this.surface, 'pointerdown', (e) => {
      this.lastPointerType = e.pointerType;
    });
    this.on(this.surface, 'pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      const nowT = performance.now();
      const rect = this.surface.getBoundingClientRect();
      const side = e.clientX < rect.left + rect.width / 2 ? -1 : 1;
      if (this.lastTap && nowT - this.lastTap.t < 320 && this.lastTap.side === side) {
        clearTimeout(this.tapTimer);
        this.lastTap = { t: nowT, side };
        this.seekBy(side * H.SEEK_STEP_S, 'user', { ripple: side });
        return;
      }
      this.lastTap = { t: nowT, side };
      clearTimeout(this.tapTimer);
      this.tapTimer = setTimeout(() => {
        if (this.root.dataset.controls === 'hidden') this.showControls();
        else if (!this.video.paused) this.hideControls(true);
      }, 260);
    });
    this.on(document, 'keydown', (e) => {
      if (e.key === 'Tab') this.pointerFocus = false;
    }, true);
  }

  // ───────────────────────────── Loading ─────────────────────────────
  playbackPrefs() {
    return this.profile?.preferences?.playback || {};
  }

  subtitlePrefs() {
    return this.profile?.preferences?.subtitles || store.get('player.subtitleStyle', null) || H.DEFAULT_SUBTITLE_STYLE;
  }

  /**
   * Loads a playback descriptor (GET /api/playback/:titleId) and starts playing.
   * Can be called again for the next episode; the player keeps fullscreen and settings.
   * `exact: true` starts precisely at `startAt` (watch parties) instead of applying the
   * resume rules and showing the "Resumed at" chip.
   */
  async load(playback, { startAt = null, trailer = false, autoplay = true, exact = false } = {}) {
    const seq = ++this.loadSeq;
    if (this.playback) {
      this.finishMedia({ reason: 'switch' });
      this.curtain.classList.remove('is-open');
    }
    this.teardownEngine();
    this.hideOverlays();
    this.resetMediaState();
    this.playback = playback;
    this.trailer = !!trailer;
    this.root.dataset.state = 'loading';
    this.root.dataset.kind = playback.title?.type || 'movie';
    this.setHeading(playback.title?.title, trailer ? 'Trailer' : H.episodeLabel(playback.episode));
    const media = playback.media || {};
    this.telemetry = new Telemetry({ mode: this.mode, media, titleId: playback.titleId, episodeId: playback.episode?.id });
    this.saver = new ProgressSaver({ mode: this.mode, playback, profile: this.profile, trailer });

    const crossOrigin = this.subs.addSidecars(media.subtitleTracks || []);
    if (crossOrigin) this.video.crossOrigin = 'anonymous';
    else this.video.removeAttribute('crossorigin');
    this.subs.setStyle(this.subtitlePrefs());

    this.sources = [{ kind: media.kind, src: media.src, variants: media.variants || [] }];
    for (const f of media.fallbacks || []) if (f?.src) this.sources.push({ kind: f.kind || 'progressive', src: f.src, variants: f.variants || [] });

    const requested = Number.isFinite(startAt) ? startAt : playback.resumeAt;
    this.resumeFrom = trailer || exact ? null : H.resumePosition(requested, media.durationS);
    const startPosition = exact ? (Number.isFinite(startAt) && startAt > 0.5 ? startAt : null) : this.resumeFrom;
    this.seek.setDuration(media.durationS || 0);
    this.updateEpisodeControls();
    this.updateTimeUi();
    this.updateQualityUi();
    this.setBuffering(true);
    this.setupMediaSession();
    this.o.onMediaChange?.(playback);
    try {
      await this.startSource(0, startPosition, seq);
    } catch (err) {
      if (seq === this.loadSeq) this.onEngineError(err instanceof PlaybackError ? err : new PlaybackError('unknown', err?.message || 'Playback failed'));
      return;
    }
    if (seq !== this.loadSeq || this.errorShown) return;
    if (autoplay) this.tryPlay();
    else {
      this.setBuffering(false);
      this.updatePlayState();
    }
  }

  async startSource(index, position, seq = this.loadSeq) {
    this.teardownEngine();
    this.sourceIndex = index;
    const source = this.sources[index];
    const engine = await createEngine(this.video, source, { playbackPrefs: this.playbackPrefs() });
    if (seq !== this.loadSeq || this.destroyed) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    this.root.dataset.engine = engine.type;
    engine.on('qualities', () => {
      this.updateQualityUi();
      this.menus.quality?.refresh();
    });
    engine.on('quality', () => {
      this.updateQualityUi();
      this.menus.quality?.refresh();
    });
    engine.on('audiotracks', () => {
      this.applyAudioPreference();
      this.menus.subs?.refresh();
    });
    engine.on('texttracks', () => this.onTextTracks());
    engine.on('warning', (w) => {
      if (w.recovered) this.telemetry?.recordError({ code: w.code, message: w.message, type: 'recovered' }, { fatal: false, source: engine.type, host: engine.host, position: this.video.currentTime });
    });
    engine.on('error', (err) => this.onEngineError(err));
    engine.start({ startAt: position });
  }

  teardownEngine() {
    if (!this.engine) return;
    const e = this.engine;
    this.engine = null;
    e.destroy();
    e.detachMedia?.();
  }

  tryPlay() {
    const p = this.video.play();
    if (p?.catch) {
      p.catch((err) => {
        if (err?.name === 'NotAllowedError') {
          // Autoplay with sound was blocked: wait for the viewer.
          this.autoplayBlocked = true;
          this.setBuffering(false);
          this.revealVideo();
          this.updatePlayState();
          this.showControls();
        } else if (err?.name !== 'AbortError') console.warn(err);
      });
    }
  }

  onEngineError(err) {
    if (this.errorShown || this.destroyed) return;
    const pos = this.video.currentTime > 1 ? this.video.currentTime : this.resumeFrom;
    this.telemetry?.recordError(err, { fatal: true, source: this.engine?.type || this.sources[this.sourceIndex]?.kind, host: this.engine?.host, position: pos, fallbackIndex: this.sourceIndex, height: this.engine?.currentHeight() });
    if (this.sourceIndex + 1 < this.sources.length) {
      const next = this.sourceIndex + 1;
      const seq = this.loadSeq;
      this.notify('Switched to a backup source', 'refresh');
      this.startSource(next, pos, seq)
        .then(() => {
          if (seq === this.loadSeq && !this.errorShown) this.tryPlay();
        })
        .catch((e) => this.onEngineError(e instanceof PlaybackError ? e : new PlaybackError('unknown', e?.message || 'Playback failed')));
      return;
    }
    this.showError(err);
  }

  /** Saves progress and flushes telemetry for the current media. */
  finishMedia({ reason, keepalive = false } = {}) {
    if (!this.playback) return undefined;
    const p = this.saveProgress(reason, { keepalive });
    this.saveDiagnostics();
    this.telemetry?.stop({ keepalive });
    return p;
  }

  saveProgress(reason, { keepalive = false } = {}) {
    if (!this.saver || !this.started) return undefined;
    this.lastSaveAt = performance.now();
    return this.saver.save(this.video, { reason, keepalive });
  }

  // ───────────────────────────── Playback control ─────────────────────────────
  /** In a watch party, guests without control cannot play/pause/seek. */
  allow(origin) {
    if (origin !== 'user' || !this.party) return true;
    if (this.party.canControl()) return true;
    this.notify('The host is controlling playback', 'users');
    return false;
  }

  /**
   * A party guest whose browser blocked autoplay (or who fell behind) while the party is
   * playing may press Play to start locally and rejoin the shared timeline. This never
   * changes the party's state, so it is allowed without control rights.
   */
  canCatchUp() {
    return !!this.party && !this.party.canControl() && !!this.party.isPlaying?.() && this.video.paused && !this.video.ended;
  }

  togglePlay(origin = 'user') {
    if (this.errorShown || !this.playback) return;
    if (this.video.paused || this.video.ended) this.play(origin);
    else this.pause(origin);
  }

  play(origin = 'user') {
    if (origin === 'user' && this.canCatchUp()) {
      this.catchUp();
      return;
    }
    if (!this.allow(origin)) return;
    const v = this.video;
    if (this.endScreenShown) this.hideEndScreen();
    if (v.ended) v.currentTime = 0;
    if (this.autoplayBlocked) {
      this.telemetry?.restartStartupClock();
      this.autoplayBlocked = false;
    }
    const p = v.play();
    p?.catch?.((err) => {
      if (err?.name === 'NotAllowedError') {
        this.autoplayBlocked = true;
        this.updatePlayState();
      }
    });
    if (origin !== 'auto') this.flash('play');
    if (origin === 'user') this.party?.onControl('play', v.currentTime);
  }

  /** Local play for a party guest, then a jump to where the party is now. */
  catchUp() {
    const v = this.video;
    if (this.autoplayBlocked) this.telemetry?.restartStartupClock();
    this.autoplayBlocked = false;
    const p = v.play();
    this.flash('play');
    this.updatePlayState();
    Promise.resolve(p).then(() => this.party?.resync?.(), (err) => {
      if (err?.name === 'NotAllowedError') {
        this.autoplayBlocked = true;
        this.updatePlayState();
      }
    });
  }

  pause(origin = 'user') {
    if (!this.allow(origin)) return;
    this.video.pause();
    this.flash('pause');
    if (origin === 'user') this.party?.onControl('pause', this.video.currentTime);
  }

  duration() {
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return this.playback?.media?.durationS || 0;
  }

  seekTo(t, origin = 'user') {
    if (!this.allow(origin) || !this.playback) return;
    const d = this.duration();
    const target = Math.max(0, d ? Math.min(t, d - 0.25) : t);
    this.video.currentTime = target;
    this.seek.update(target, this.video.buffered);
    this.updateTimeUi(target);
    if (this.endScreenShown && target < d - 1) this.hideEndScreen();
    if (origin === 'user') this.party?.onControl('seek', target);
  }

  seekBy(delta, origin = 'user', { ripple } = {}) {
    if (!this.allow(origin)) return;
    this.seekTo((this.video.currentTime || 0) + delta, origin);
    if (ripple) this.ripple(ripple);
    else this.flash(delta < 0 ? 'back10' : 'fwd10');
    this.showControls();
  }

  setVolume(value) {
    const v = this.video;
    v.volume = Math.min(1, Math.max(0, value));
    if (v.volume > 0 && v.muted) v.muted = false;
    if (v.volume === 0) v.muted = true;
    store.set('player.volume', { volume: v.volume, muted: v.muted });
  }

  toggleMute() {
    const v = this.video;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
    store.set('player.volume', { volume: v.volume, muted: v.muted });
    this.flash(v.muted ? 'volumeMute' : 'volume');
  }

  setSpeed(rate) {
    if (this.party) {
      // Everyone in a party plays at the same speed.
      this.notify('Playback speed stays at normal in watch parties', 'speed');
      return;
    }
    this.video.playbackRate = rate;
    this.notify(`Speed ${rate === 1 ? 'normal' : `${rate}×`}`, 'speed');
  }

  stepSpeed(dir) {
    const i = H.SPEEDS.indexOf(this.video.playbackRate);
    const next = H.SPEEDS[Math.min(H.SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
    if (next !== this.video.playbackRate) this.setSpeed(next);
  }

  // ───────────────────────────── Media events ─────────────────────────────
  onTimeUpdate() {
    const v = this.video;
    const t = v.currentTime;
    if (!v.paused && !v.seeking && this.lastTime !== null) {
      const d = H.playedDelta(this.lastTime, t, v.playbackRate);
      if (d > 0) {
        this.saver?.addWatched(d);
        // Measured payload bitrate only: a playlist's declared BANDWIDTH is not a measurement.
        this.telemetry?.addWatched(d, { bitrate: this.engine?.playingBitrate(), height: this.engine?.currentHeight() });
      }
    }
    this.lastTime = t;
    this.updateTimeUi();
    this.checkMarkers(t);
  }

  onDuration() {
    const d = this.duration();
    this.seek.setDuration(d);
    const m = this.playback?.media || {};
    this.seek.setMarkers({ introStart: m.introStart, introEnd: m.introEnd, credits: Number.isFinite(m.creditsStart) ? m.creditsStart : null });
    // The saved position may turn out to be in the last 5 % now that the duration is known.
    if (this.resumeFrom && d && H.resumePosition(this.resumeFrom, d) === null && this.video.currentTime >= d * H.RESUME_MAX_RATIO) {
      this.resumeFrom = null;
      this.video.currentTime = 0;
    }
    if (this.resumeFrom && !this.resumeChipShown) this.showResumeChip(this.resumeFrom);
    this.updateTimeUi();
    this.updateQualityUi();
  }

  onEnded() {
    this.ended = true;
    this.saveProgress('ended');
    this.telemetry?.flush();
    this.updatePlayState();
    const next = this.playback?.next;
    if (this.playback?.title?.type === 'series' && next && !this.trailer) {
      if (this.autoplayAllowed() && !this.nextCancelled && this.canDrive()) {
        this.playNext('autoplay');
        return;
      }
    }
    this.showEndScreen();
  }

  revealVideo() {
    if (!this.curtain.classList.contains('is-open')) this.curtain.classList.add('is-open');
    if (this.root.dataset.state === 'loading') this.root.dataset.state = 'ready';
  }

  setBuffering(on) {
    this.buffering = !!on;
    this.loader.hidden = !on;
    this.root.classList.toggle('is-buffering', !!on);
  }

  // ───────────────────────────── Intro, credits, next ─────────────────────────────
  autoplayAllowed() {
    const p = this.profile;
    if (!p) return true;
    return p.autoplayNext !== false && p.preferences?.playback?.autoplayNext !== false;
  }

  /** Whether this player may advance episodes on its own (in a party only the host does). */
  canDrive() {
    return !this.party || (this.party.canControl() && this.party.isHost());
  }

  checkMarkers(t) {
    const pb = this.playback;
    if (!pb || this.trailer) return;
    const m = pb.media || {};
    const locked = this.party && !this.party.canControl();
    const intro = H.inIntro(t, m);
    // In a party only the host skips automatically (and the skip is shared with everyone).
    if (intro && !this.introHandled && this.playbackPrefs().skipIntro && this.canDrive() && !this.video.paused) {
      this.skipIntro(true);
      return;
    }
    this.skipIntroBtn.hidden = !intro || locked;

    const d = this.duration();
    const creditsT = H.creditsAt(m, d);
    const inCredits = creditsT !== null && t >= creditsT && !this.ended;
    const series = pb.title?.type === 'series';
    const next = pb.next;
    if (series && next) {
      if (inCredits && !this.nextCard && !this.nextCancelled) this.showNextCard(next);
      else if (!inCredits && this.nextCard && t < creditsT - 1) this.hideNextCard();
      if (inCredits && !this.creditsHandled && this.playbackPrefs().skipCredits && this.autoplayAllowed() && this.canDrive()) {
        this.creditsHandled = true;
        this.playNext('skip-credits');
      }
    } else {
      const known = Number.isFinite(m.creditsStart);
      this.skipCreditsBtn.hidden = !(known && inCredits) || this.endScreenShown || locked;
      if (known && inCredits && !this.creditsHandled && this.playbackPrefs().skipCredits && !this.party) {
        this.creditsHandled = true;
        this.skipCredits();
      }
    }
  }

  skipIntro(auto) {
    const end = this.playback?.media?.introEnd;
    if (!Number.isFinite(end)) return;
    this.introHandled = true;
    this.skipIntroBtn.hidden = true;
    // A party host's automatic skip is broadcast like a manual one.
    this.seekTo(end, auto && !this.party ? 'auto' : 'user');
    this.notify(auto ? 'Intro skipped' : 'Skipped intro', 'skipNext');
  }

  skipCredits() {
    this.skipCreditsBtn.hidden = true;
    this.creditsHandled = true;
    if (this.party) this.pause('user');
    else this.video.pause();
    this.showEndScreen({ fromCredits: true });
  }

  showNextCard(ep) {
    const autoplay = this.autoplayAllowed() && this.canDrive();
    let remaining = NEXT_COUNTDOWN_S;
    const ring = h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 36 36', class: 'lm-player__ring', 'aria-hidden': 'true' },
      h('circle', { cx: 18, cy: 18, r: 16, class: 'lm-player__ring-bg' }),
      h('circle', { cx: 18, cy: 18, r: 16, class: 'lm-player__ring-fg' }));
    const count = h('span', { class: 'lm-player__next-count' });
    const guestNote = this.party && !this.canDrive();
    const card = h('div', { class: 'lm-player__next', role: 'region', 'aria-label': 'Next episode' },
      ep.still ? h('img', { class: 'lm-player__next-still', src: ep.still, alt: '' }) : null,
      h('div', { class: 'lm-player__next-body' },
        h('span', { class: 'lm-eyebrow' }, 'Next episode'),
        h('strong', null, H.episodeLabel(ep)),
        autoplay ? h('span', { class: 'lm-player__next-meta' }, ring, count) : guestNote ? h('span', { class: 'lm-player__next-meta' }, 'The host decides when to continue') : null,
        h('div', { class: 'lm-player__next-actions' },
          guestNote ? null : btn('Play now', { variant: 'light', size: 'sm', iconName: 'play', onClick: () => this.playNext('card') }),
          btn(autoplay ? 'Cancel' : 'Dismiss', { variant: 'glass', size: 'sm', onClick: () => { this.nextCancelled = true; this.hideNextCard(); } }))));
    const paint = () => {
      count.textContent = `Starts in ${remaining}s`;
      ring.lastChild.style.strokeDashoffset = String(100.5 * (1 - remaining / NEXT_COUNTDOWN_S));
    };
    this.nextCard = {
      el: card,
      tick: () => {
        if (!autoplay || this.video.paused) return;
        remaining -= 1;
        if (remaining <= 0) {
          this.playNext('autoplay');
          return;
        }
        paint();
      },
    };
    if (autoplay) paint();
    this.chips.prepend(card);
    this.announce(`Next episode: ${H.episodeLabel(ep)}${autoplay ? `, starts in ${remaining} seconds` : ''}`);
  }

  hideNextCard() {
    this.nextCard?.el.remove();
    this.nextCard = null;
  }

  playNext(reason) {
    const next = this.playback?.next;
    if (!next) return;
    if (reason !== 'autoplay' && reason !== 'skip-credits' && !this.allow('user')) return;
    this.hideNextCard();
    this.o.onEpisodeRequest?.(next, { reason });
  }

  // ───────────────────────────── Overlays ─────────────────────────────
  showResumeChip(pos) {
    this.resumeChipShown = true;
    const chip = this.resumeChip;
    chip.replaceChildren(
      icon('history'),
      h('span', null, `Resumed at ${clock(pos)}`),
      h('button', { type: 'button', class: 'lm-player__resume-btn', onClick: () => { this.seekTo(0, 'user'); chip.hidden = true; this.notify('Starting from the beginning', 'refresh'); } }, 'Start over'));
    chip.hidden = false;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => { chip.hidden = true; }, 9000);
  }

  hideOverlays() {
    this.hideNextCard();
    this.hideEndScreen();
    this.skipIntroBtn.hidden = true;
    this.skipCreditsBtn.hidden = true;
    this.resumeChip.hidden = true;
    this.resumeChipShown = false;
    this.errorEl.hidden = true;
    this.errorEl.replaceChildren();
    this.hideStallHint();
    for (const m of Object.values(this.menus)) m.close();
  }

  async showEndScreen({ fromCredits = false } = {}) {
    if (this.endScreenShown) return;
    this.endScreenShown = true;
    this.hideNextCard();
    this.skipCreditsBtn.hidden = true;
    const pb = this.playback;
    const t = pb.title || {};
    const series = t.type === 'series';
    const next = pb.next;
    const guest = this.party && !this.canDrive();
    const actions = [];
    if (series && next && !guest) actions.push(btn('Play next episode', { variant: 'light', iconName: 'play', onClick: () => this.playNext('end') }));
    if (fromCredits) actions.push(btn('Watch the credits', { variant: 'glass', iconName: 'play', onClick: () => { this.hideEndScreen(); this.play('user'); } }));
    if (!guest) actions.push(btn(series ? 'Watch episode again' : 'Watch again', { variant: 'glass', iconName: 'refresh', onClick: () => { this.hideEndScreen(); this.seekTo(0, 'user'); this.play('user'); } }));
    actions.push(btn('Back to title', { variant: 'ghost', iconName: 'arrowLeft', onClick: () => this.goBack() }));
    const rec = h('div', { class: 'lm-player__recs' });
    const heading = h('h2', { class: 'lm-player__end-title', tabindex: '-1' }, series && next ? `Up next: ${H.episodeLabel(next)}` : `You finished ${t.title || 'this title'}`);
    this.endEl.replaceChildren(
      h('div', { class: 'lm-player__end-inner' },
        h('span', { class: 'lm-eyebrow' }, series && next ? 'Keep watching' : 'The end'),
        heading,
        guest ? h('p', { class: 'lm-player__end-note' }, 'The host decides what the party watches next.') : null,
        h('div', { class: 'lm-player__end-actions' }, ...actions),
        rec));
    this.endEl.hidden = false;
    this.root.dataset.state = 'ended';
    this.showControls();
    heading.focus({ preventScroll: true });
    if (!(series && next)) this.loadRecommendations(rec, t);
  }

  async loadRecommendations(container, t) {
    try {
      const { items } = await api.catalog.similar(t.id);
      if (!items?.length || !this.endScreenShown) return;
      container.replaceChildren(
        h('h3', { class: 'lm-player__recs-title' }, 'More like this'),
        h('ul', { class: 'lm-player__recs-list', role: 'list' }, ...items.slice(0, 6).map((s) => h('li', null,
          h('a', { class: 'lm-player__rec', href: `#/title/${encodeURIComponent(s.id)}` },
            h('span', { class: 'lm-player__rec-art' }, s.backdrop || s.poster ? h('img', { src: s.backdrop || s.poster, alt: '', loading: 'lazy' }) : null),
            h('span', { class: 'lm-player__rec-title' }, s.title),
            h('span', { class: 'lm-player__rec-meta' }, [s.year, s.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · ')))))));
    } catch {
      /* recommendations are optional */
    }
  }

  hideEndScreen() {
    if (!this.endScreenShown) return;
    this.endScreenShown = false;
    this.endEl.hidden = true;
    this.endEl.replaceChildren();
    if (this.root.dataset.state === 'ended') this.root.dataset.state = 'ready';
  }

  showStallHint() {
    if (this.stallHint || this.errorShown) return;
    this.stallHint = true;
    const lower = this.engine?.canLowerQuality?.();
    replace(this.stallEl,
      h('span', null, 'Still buffering — your connection may be slow'),
      lower ? h('button', { type: 'button', class: 'lm-player__stall-btn', onClick: () => this.lowerQuality() }, 'Lower quality') : null);
    this.stallEl.hidden = false;
    this.announce('Still buffering. Your connection may be slow.');
  }

  hideStallHint() {
    if (!this.stallHint) return;
    this.stallHint = false;
    this.stallEl.hidden = true;
  }

  lowerQuality() {
    const opt = this.engine?.lowerQuality?.();
    this.hideStallHint();
    this.progressAt = performance.now();
    if (opt) this.notify(`Quality lowered to ${opt.label}`, 'hd');
    this.updateQualityUi();
  }

  /**
   * Error overlay. `err` is a PlaybackError (type) or an ApiError (code/status).
   * Never leaves a black screen: every error has a way back.
   */
  showError(err, { title } = {}) {
    this.errorShown = err || new PlaybackError('unknown', 'Unknown error');
    this.setBuffering(false);
    this.hideStallHint();
    this.hideNextCard();
    for (const m of Object.values(this.menus)) m.close();
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
    if (title) this.setHeading(title, '');
    const kind = err?.type || err?.code || (err?.status === 0 ? 'NETWORK' : 'unknown');
    const info = H.describeError(kind === 'NOT_FOUND' && err?.status === 404 ? 'NOT_FOUND' : kind);
    const retry = btn('Try again', { variant: 'primary', iconName: 'refresh', onClick: () => this.retry() });
    const back = btn('Back', { variant: 'glass', iconName: 'arrowLeft', onClick: () => this.goBack() });
    const report = btn('Report a problem', { variant: 'ghost', iconName: 'flag', onClick: () => this.openReport('playback_error') });
    const actions = [info.retry ? retry : null, back];
    if (kind === 'PROFILE_RESTRICTED') actions.push(h('a', { class: 'lm-btn lm-btn--ghost', href: '#/profiles' }, icon('users'), h('span', null, 'Switch profile')));
    if (kind !== 'PROFILE_RESTRICTED' && kind !== 'ENTITLEMENT_REQUIRED' && this.playback) actions.push(report);
    const code = err?.code && err.code !== kind ? err.code : err?.httpStatus ? `HTTP ${err.httpStatus}` : null;
    const headingId = `perr-${this.loadSeq}`;
    this.errorEl.setAttribute('aria-labelledby', headingId);
    this.errorEl.replaceChildren(h('div', { class: 'lm-player__error-panel' },
      h('div', { class: 'lm-player__error-icon', 'aria-hidden': 'true' }, icon('lantern')),
      h('h2', { id: headingId }, info.title),
      h('p', null, info.message),
      code ? h('p', { class: 'lm-player__error-code' }, `Error code: ${code}`) : null,
      h('div', { class: 'lm-player__error-actions' }, ...actions.filter(Boolean))));
    this.errorEl.hidden = false;
    this.root.dataset.state = 'error';
    this.curtain.classList.add('is-open');
    this.showControls();
    (info.retry ? retry : back).focus({ preventScroll: true });
  }

  retry() {
    const pos = this.video.currentTime > 1 ? this.video.currentTime : this.resumeFrom;
    this.errorEl.hidden = true;
    this.errorShown = null;
    // A watch party reloads at the party's position, not at the viewer's own.
    if (this.party && this.o.onRetryLoad) this.o.onRetryLoad();
    else if (this.playback) this.load(this.playback, { startAt: pos, trailer: this.trailer });
    else this.o.onRetryLoad?.();
  }

  // ───────────────────────────── UI state ─────────────────────────────
  setHeading(title, sub) {
    this.titleEl.textContent = title || '';
    this.subtitleEl.textContent = sub || '';
    this.subtitleEl.hidden = !sub;
  }

  updatePlayState() {
    const v = this.video;
    const playing = !v.paused && !v.ended;
    const label = playing ? 'Pause (k)' : 'Play (k)';
    this.playBtn.setIcon(playing ? 'pause' : 'play');
    this.playBtn.setLabel(label);
    this.bigPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
    this.bigPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.root.dataset.playing = String(playing);
    this.root.classList.toggle('is-blocked', this.autoplayBlocked);
    if (!this.errorShown && !this.endScreenShown && this.root.dataset.state !== 'loading') this.root.dataset.state = playing ? 'playing' : 'paused';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (this.party) this.applyPartyLock();
    if (playing) this.scheduleHide();
    else this.showControls();
  }

  updateTimeUi(at) {
    const v = this.video;
    const t = at ?? v.currentTime ?? 0;
    const d = this.duration();
    this.seek.update(t, v.buffered);
    const text = this.showRemaining && d ? `-${clock(Math.max(0, d - t))}` : `${clock(t)}${d ? ` / ${clock(d)}` : ''}`;
    if (this.timeBtn.textContent !== text) this.timeBtn.textContent = text;
  }

  toggleRemaining() {
    this.showRemaining = !this.showRemaining;
    store.set('player.remaining', this.showRemaining);
    this.timeBtn.setAttribute('aria-label', this.showRemaining ? 'Show elapsed time' : 'Show remaining time');
    this.updateTimeUi();
  }

  updateVolumeUi() {
    const v = this.video;
    const level = v.muted ? 0 : v.volume;
    this.muteBtn.setIcon(level === 0 ? 'volumeMute' : level < 0.5 ? 'volumeLow' : 'volume');
    this.muteBtn.setLabel(v.muted ? 'Unmute (m)' : 'Mute (m)');
    this.volume.value = String(Math.round(level * 100));
    this.volume.setAttribute('aria-valuetext', `Volume ${Math.round(level * 100)}%${v.muted ? ', muted' : ''}`);
    this.volume.style.setProperty('--fill', `${Math.round(level * 100)}%`);
  }

  updateEpisodeControls() {
    const pb = this.playback;
    const series = pb?.title?.type === 'series' && !this.trailer;
    this.nextBtn.hidden = !(series && pb.next);
    this.episodesBtn.hidden = !series;
    if (pb?.next) this.nextBtn.setLabel(`Next episode: ${H.episodeLabel(pb.next)} (n)`);
    this.applyPartyLock();
  }

  /** Current quality as shown on the button and in reports: "Auto · 1080p", "720p"… */
  qualitySummary() {
    const e = this.engine;
    if (!e) return 'Auto';
    const hgt = e.currentHeight();
    if (e.isAuto) return H.autoLabel(hgt, { capped: !!e.capHeight });
    const opt = e.qualities().find((o) => o.id === e.selectedQualityId());
    return opt?.label || (hgt ? H.heightLabel(hgt) : 'Source');
  }

  updateQualityUi() {
    const e = this.engine;
    const hgt = e?.currentHeight() || 0;
    let text = 'Auto';
    if (e) {
      const shortOf = (x) => (x >= 2160 ? '4K' : x ? `${x}p` : '');
      if (e.isAuto) text = hgt ? `Auto · ${shortOf(hgt)}` : 'Auto';
      else {
        // Manual choice: show what was picked (the switch lands at the next segment).
        const picked = e.qualities().find((o) => o.id === e.selectedQualityId());
        text = shortOf(picked?.height || hgt) || 'Source';
      }
    }
    this.qualityText.textContent = text;
    const summary = this.qualitySummary();
    this.qualityBtn.setAttribute('aria-label', `Quality: ${summary}`);
    this.qualityBtn.dataset.tip = `Quality: ${summary}`;
    this.qualityBtn.classList.toggle('is-uhd', hgt >= 2160);
  }

  // ───────────────────────────── Controls visibility ─────────────────────────────
  anyMenuOpen() {
    return Object.values(this.menus).some((m) => m.isOpen);
  }

  shouldStayVisible() {
    const v = this.video;
    return v.paused || v.ended || !!this.errorShown || this.anyMenuOpen() || !!this.dialog || this.overControls || this.endScreenShown || this.autoplayBlocked || this.scrubbing || this.keyboardFocusInChrome();
  }

  /**
   * A keyboard user has focus on a player control: hiding the controls would hide the
   * focused control and its focus ring (WCAG 2.4.7), so they stay up until focus leaves
   * them or Esc puts them away.
   */
  keyboardFocusInChrome() {
    if (this.pointerFocus) return false;
    const a = document.activeElement;
    if (!a || a === this.root || !this.root.contains(a) || !a.closest('.lm-player__chrome')) return false;
    try {
      return a.matches(':focus-visible');
    } catch {
      return true; // no :focus-visible support: Tab was the last interaction
    }
  }

  showControls() {
    if (this.root.dataset.controls !== 'visible') this.root.dataset.controls = 'visible';
    this.scheduleHide();
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (this.shouldStayVisible()) return;
    this.hideTimer = setTimeout(() => this.hideControls(), HIDE_AFTER_MS);
  }

  hideControls(force = false) {
    clearTimeout(this.hideTimer);
    if (!force && this.shouldStayVisible()) return;
    if (force && (this.anyMenuOpen() || this.dialog)) return;
    this.root.dataset.controls = 'hidden';
  }

  onMenuToggle(open) {
    this.root.classList.toggle('has-menu', this.anyMenuOpen());
    if (open) this.showControls();
    else this.scheduleHide();
  }

  flash(name) {
    const f = this.flashEl;
    f.replaceChildren(icon(name));
    f.classList.remove('is-on');
    void f.offsetWidth;
    f.classList.add('is-on');
  }

  ripple(side) {
    const el = side < 0 ? this.rippleL : this.rippleR;
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
  }

  /** Brief on-screen message (inside the player, so it shows in fullscreen too). */
  notify(message, iconName = 'info', timeout = 2600) {
    const el = h('div', { class: 'lm-player__toast' }, playerIcon(iconName), h('span', null, message));
    this.osd.append(el);
    while (this.osd.children.length > 3) this.osd.firstElementChild.remove();
    this.announce(message);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 260);
    }, timeout);
  }

  announce(message) {
    this.live.textContent = '';
    setTimeout(() => { this.live.textContent = message; }, 40);
  }

  // ───────────────────────────── Menus ─────────────────────────────
  qualityMenuItems() {
    const e = this.engine;
    if (!e) return [{ type: 'note', label: 'Loading the stream…' }];
    const opts = e.qualities();
    const items = [];
    if (e.supportsAuto) {
      items.push({ type: 'radio', label: e.isAuto ? H.autoLabel(e.currentHeight(), { capped: !!e.capHeight }) : 'Auto', sub: 'Adjusts to your connection', checked: e.isAuto, onSelect: () => this.setQuality('auto') });
    }
    const selected = e.selectedQualityId();
    for (const o of opts) {
      items.push({ type: 'radio', label: o.label, sub: o.bitrate ? H.formatBitrate(o.bitrate) : o.source ? 'The only rendition of this video' : null, checked: !e.isAuto && selected === o.id, onSelect: () => this.setQuality(o.id) });
    }
    if (e.type === 'native-hls') items.push({ type: 'note', label: 'Your browser picks the quality for this stream automatically.' });
    if (!items.length) items.push({ type: 'note', label: 'The resolution will appear once the video loads.' });
    return items;
  }

  setQuality(id) {
    const e = this.engine;
    if (!e) return;
    e.setQuality(id);
    if (id === 'auto') this.notify('Quality: Auto', 'hd');
    else {
      const o = e.qualities().find((x) => x.id === id);
      if (o) this.notify(`Quality: ${o.label}`, 'hd');
    }
    this.updateQualityUi();
  }

  /**
   * Display name of a real audio track. Packagers often name renditions "audio_0"; the
   * verified media metadata may carry a better name for the same language, which is used
   * then. The list of tracks itself always comes from the stream.
   */
  audioLabel(t) {
    const meta = (this.playback?.media?.audioTracks || []).filter((m) => m.label && H.langMatches(m.lang, t.lang));
    const generic = !t.label || t.label === t.lang || H.isGenericTrackName(t.label);
    if (generic && meta.length === 1) return meta[0].label;
    return generic ? languageName(t.lang) || t.label || 'Audio' : t.label;
  }

  audioItems() {
    const e = this.engine;
    const real = e?.audioTracks() || [];
    if (real.length) {
      return real.map((t) => {
        const label = this.audioLabel(t);
        const lang = t.lang ? languageName(t.lang) : '';
        return {
          type: 'radio',
          label,
          sub: lang && !label.toLowerCase().includes(lang.toLowerCase()) ? lang : null,
          checked: t.selected,
          disabled: !t.switchable && !t.selected,
          onSelect: () => this.setAudio({ ...t, label }),
        };
      });
    }
    // The browser does not expose audio tracks: fall back to the verified media metadata.
    const meta = this.playback?.media?.audioTracks || [];
    if (meta.length === 1 || meta.length === 0) {
      const t = meta[0];
      return [{ type: 'radio', label: t ? t.label || languageName(t.lang) : 'Original audio', checked: true, onSelect: () => {} }];
    }
    const def = Math.max(0, meta.findIndex((t) => t.default));
    return meta.map((t, i) => ({ type: 'radio', label: t.label || languageName(t.lang), sub: i === def ? null : 'Not switchable in this browser', checked: i === def, disabled: i !== def, onSelect: () => {} }));
  }

  setAudio(t) {
    if (t.selected) return;
    this.engine?.setAudioTrack(t.id);
    this.notify(`Audio: ${t.label || languageName(t.lang)}`, 'audio');
  }

  applyAudioPreference() {
    if (this.audioPrefApplied) return;
    const tracks = this.engine?.audioTracks() || [];
    if (tracks.length < 2) return;
    this.audioPrefApplied = true;
    const remembered = sessionStorageGet('lumina.player.audioLang');
    const idx = H.pickAudioTrack(tracks, { preferred: remembered || this.profile?.audioLanguage });
    if (idx >= 0 && !tracks[idx].selected) this.engine.setAudioTrack(tracks[idx].id);
  }

  subtitleItems() {
    const tracks = this.subs.tracks();
    const sel = this.subs.selectedId;
    const items = [{ type: 'radio', label: 'Off', checked: sel === 'off', onSelect: () => this.setSubtitle('off') }];
    for (const t of tracks) {
      const lang = languageName(t.lang);
      items.push({ type: 'radio', label: t.label, sub: lang && !t.label.toLowerCase().includes(lang.toLowerCase()) ? lang : null, checked: sel === t.id, onSelect: () => this.setSubtitle(t.id) });
    }
    if (!tracks.length) items.push({ type: 'note', label: 'No subtitles are available for this video.' });
    return items;
  }

  subsMenuItems() {
    return [
      { type: 'group', label: 'Audio', items: this.audioItems() },
      { type: 'separator' },
      { type: 'group', label: 'Subtitles', items: this.subtitleItems() },
      { type: 'separator' },
      { type: 'action', label: 'Subtitle appearance…', icon: 'palette', onSelect: () => this.openSubtitleEditor(), noFocusReturn: true },
    ];
  }

  setSubtitle(id, { quiet = false } = {}) {
    const t = this.subs.selectById(id);
    const lang = t ? t.lang : 'off';
    sessionStorageSet('lumina.player.subtitleLang', lang || 'off');
    this.subsBtn.classList.toggle('is-active', !!t);
    if (!quiet) this.notify(t ? `Subtitles: ${t.label}` : 'Subtitles off', 'subtitles');
  }

  /** Captions shortcut (C): toggle between off and the last/best track. */
  toggleCaptions() {
    if (this.subs.selected) {
      this.lastSubtitleId = this.subs.selectedId;
      this.setSubtitle('off');
      return;
    }
    const tracks = this.subs.tracks();
    if (!tracks.length) {
      this.notify('No subtitles for this video', 'subtitles');
      return;
    }
    const pick = tracks.find((t) => t.id === this.lastSubtitleId)
      || tracks[Math.max(0, H.pickSubtitleTrack(tracks, { subtitlesDefault: true, subtitleLanguage: this.profile?.subtitleLanguage, uiLanguage: this.profile?.uiLanguage || document.documentElement.lang }))];
    this.setSubtitle(pick.id);
  }

  onTextTracks() {
    // Auto-select once per media when the profile wants subtitles (or the viewer chose a
    // language earlier in this session).
    const tracks = this.subs.tracks();
    if (!this.trackPrefsApplied && tracks.length) {
      const remembered = sessionStorageGet('lumina.player.subtitleLang');
      let idx = -1;
      if (remembered && remembered !== 'off') idx = tracks.findIndex((t) => H.langMatches(t.lang, remembered));
      else if (!remembered) idx = H.pickSubtitleTrack(tracks, { subtitlesDefault: !!this.profile?.subtitlesDefault, subtitleLanguage: this.profile?.subtitleLanguage, uiLanguage: this.profile?.uiLanguage });
      if (idx >= 0) {
        this.trackPrefsApplied = true;
        this.subs.select(tracks[idx].track);
        this.subsBtn.classList.add('is-active');
      } else if (remembered === 'off' || tracks.some((t) => !t.sidecar) || this.started) {
        this.trackPrefsApplied = true;
      }
    }
    this.menus.subs?.refresh();
  }

  settingsMenuItems() {
    const rate = this.video.playbackRate;
    const items = [];
    if (!this.party) {
      items.push({
        type: 'submenu',
        label: 'Playback speed',
        icon: 'speed',
        value: rate === 1 ? 'Normal' : `${rate}×`,
        title: 'Playback speed',
        items: () => H.SPEEDS.map((s) => ({ type: 'radio', label: s === 1 ? 'Normal' : `${s}×`, checked: s === rate, onSelect: () => this.setSpeed(s) })),
      });
    }
    items.push(
      { type: 'check', label: 'Stats for nerds', checked: this.statsVisible, onSelect: () => this.toggleStats() },
      { type: 'action', label: 'Keyboard shortcuts', icon: 'grid', onSelect: () => this.openShortcuts(), noFocusReturn: true },
      { type: 'separator' },
      { type: 'action', label: 'Report a playback problem', icon: 'flag', onSelect: () => this.openReport(), noFocusReturn: true },
    );
    return items;
  }

  // ───────────────────────────── Dialogs ─────────────────────────────
  openPlayerDialog(opts) {
    this.dialog?.close();
    const d = playerDialog(this.root, {
      ...opts,
      onClose: (v) => {
        if (this.dialog === d) this.dialog = null;
        opts.onClose?.(v);
        this.scheduleHide();
      },
    });
    this.dialog = d;
    this.showControls();
    return d;
  }

  openShortcuts() {
    const rows = [
      [['Space', 'K'], 'Play or pause'],
      [['←', 'J'], 'Back 10 seconds'],
      [['→', 'L'], 'Forward 10 seconds'],
      [['↑', '↓'], 'Volume up or down'],
      [['M'], 'Mute'],
      [['F'], 'Full screen'],
      [['C'], 'Subtitles on or off'],
      [['P'], 'Picture in picture'],
      [['N'], 'Next episode'],
      [['S'], 'Skip intro'],
      // Speed is fixed in watch parties (see setSpeed).
      ...(this.party ? [] : [[['Shift', '.'], 'Faster'], [['Shift', ','], 'Slower']]),
      [['0 … 9'], 'Jump to 0 … 90 %'],
      [['I'], 'Stats for nerds'],
      [['Esc'], 'Close menus, hide the controls or leave full screen'],
      [['?'], 'This list'],
    ];
    this.openPlayerDialog({
      title: 'Keyboard shortcuts',
      className: 'lm-player__shortcuts',
      content: h('table', { class: 'lm-player__keys' },
        h('caption', { class: 'visually-hidden' }, 'Player keyboard shortcuts'),
        h('tbody', null, ...rows.map(([keys, what]) => h('tr', null,
          h('th', { scope: 'row' }, ...keys.flatMap((k, i) => [i ? h('span', { class: 'lm-player__keysep' }, k === '.' || k === ',' ? '+' : ' / ') : null, h('kbd', { class: 'lm-kbd' }, k)])),
          h('td', null, what))))),
    });
  }

  openSubtitleEditor() {
    const original = H.subtitleStyle(this.subtitlePrefs());
    let draft = { size: original.size, color: original.color, background: original.background, position: original.position };
    const preview = h('div', { class: 'lm-subs lm-subs--preview', 'aria-hidden': 'true' },
      h('div', { class: 'lm-subs__cue' }, h('span', { class: 'lm-subs__line' }, 'The garden is quiet tonight —'), h('span', { class: 'lm-subs__line' }, h('span', { class: 'is-italic' }, 'lanterns'), ' glow beside the pond.')));
    const stage = h('div', { class: 'lm-player__sub-stage' }, preview);
    const apply = () => {
      SubtitleManager.preview(preview, draft);
      this.subs.setStyle(draft);
    };
    const seg = (label, key, options) => {
      const group = h('div', { class: 'lm-segmented', role: 'radiogroup', 'aria-label': label });
      const buttons = options.map(([value, text]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(draft[key] === value), tabindex: draft[key] === value ? '0' : '-1' }, text);
        b.addEventListener('click', () => select(value));
        return b;
      });
      const select = (value, focus = false) => {
        draft = { ...draft, [key]: value };
        buttons.forEach((b, i) => {
          const on = options[i][0] === value;
          b.setAttribute('aria-checked', String(on));
          b.setAttribute('aria-pressed', String(on));
          b.tabIndex = on ? 0 : -1;
          if (on && focus) b.focus();
        });
        apply();
      };
      group.addEventListener('keydown', (e) => {
        const i = options.findIndex(([value]) => value === draft[key]);
        let j = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % options.length;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + options.length) % options.length;
        if (j !== null) {
          e.preventDefault();
          select(options[j][0], true);
        }
      });
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === draft[key])));
      group.append(...buttons);
      return h('div', { class: 'lm-player__field' }, h('span', { class: 'lm-player__field-label' }, label), group);
    };
    const swatches = h('div', { class: 'lm-player__swatches', role: 'radiogroup', 'aria-label': 'Text colour' });
    const custom = h('input', { type: 'color', class: 'lm-player__color', value: draft.color.toLowerCase(), 'aria-label': 'Custom text colour' });
    const paintSwatches = () => {
      swatches.querySelectorAll('button').forEach((b) => {
        const on = b.dataset.color.toUpperCase() === draft.color.toUpperCase();
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      custom.value = draft.color.toLowerCase();
    };
    const COLOR_NAMES = { '#F8F5F2': 'Warm white', '#FFE27A': 'Yellow', '#9EE6FF': 'Sky blue', '#B8F5A3': 'Green', '#FFB3C6': 'Pink' };
    for (const c of H.SUBTITLE_COLORS) {
      const b = h('button', { type: 'button', role: 'radio', class: 'lm-player__swatch', style: { '--swatch': c }, 'aria-label': COLOR_NAMES[c] || c, dataset: { color: c } });
      b.addEventListener('click', () => {
        draft = { ...draft, color: c };
        paintSwatches();
        apply();
      });
      swatches.append(b);
    }
    swatches.addEventListener('keydown', (e) => {
      const list = [...swatches.querySelectorAll('button')];
      const i = list.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      let j = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (Math.max(i, -1) + 1) % list.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (Math.max(i, 0) - 1 + list.length) % list.length;
      if (j !== null) {
        e.preventDefault();
        list[j].click();
        list[j].focus();
      }
    });
    custom.addEventListener('input', () => {
      draft = { ...draft, color: custom.value.toUpperCase() };
      paintSwatches();
      apply();
    });
    paintSwatches();
    const form = h('div', { class: 'lm-player__sub-editor' },
      stage,
      seg('Size', 'size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']]),
      h('div', { class: 'lm-player__field' }, h('span', { class: 'lm-player__field-label' }, 'Text colour'), h('div', { class: 'lm-player__colors' }, swatches, custom)),
      seg('Background', 'background', [['none', 'None'], ['shadow', 'Shadow'], ['box', 'Box']]),
      seg('Position', 'position', [['bottom', 'Bottom'], ['raised', 'Raised'], ['top', 'Top']]),
      h('p', { class: 'lm-player__hint' }, this.profile ? `Saved to the ${this.profile.name} profile${this.mode === 'static' ? ' on this device' : ''}.` : 'Saved on this device.'));
    apply();
    let saved = false;
    const saveBtn = btn('Save', { variant: 'primary', attrs: { 'data-autofocus': '' } });
    const d = this.openPlayerDialog({
      title: 'Subtitle appearance',
      className: 'lm-player__dialog--editor',
      content: form,
      actions: [
        btn('Reset', { variant: 'ghost', onClick: () => { draft = { ...H.DEFAULT_SUBTITLE_STYLE }; d.close(); this.openSubtitleEditorWith(draft); } }),
        btn('Cancel', { variant: 'glass', onClick: () => d.close() }),
        saveBtn,
      ],
      onClose: () => {
        if (!saved) this.subs.setStyle(this.subtitlePrefs());
      },
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await this.saveSubtitleStyle(draft);
        saved = true;
        d.close();
        this.notify('Subtitle style saved', 'checkCircle');
      } catch (err) {
        saveBtn.disabled = false;
        this.notify(err?.message || 'Could not save the subtitle style', 'alert');
      }
    });
  }

  openSubtitleEditorWith(style) {
    // Reset: show the editor again starting from the defaults (not saved until Save).
    const prev = this.profile;
    const patched = prev ? { ...prev, preferences: { ...prev.preferences, subtitles: style } } : null;
    this.profile = patched;
    const stash = store.get('player.subtitleStyle', null);
    if (!prev) store.set('player.subtitleStyle', style);
    this.openSubtitleEditor();
    this.profile = prev;
    if (!prev) store.set('player.subtitleStyle', stash);
  }

  async saveSubtitleStyle(style) {
    const clean = { size: style.size, color: style.color, background: style.background, position: style.position };
    if (this.profile?.id) {
      const res = await api.profiles.updatePreferences(this.profile.id, { subtitles: clean });
      if (res?.profile) {
        this.profile = res.profile;
        setProfile(res.profile);
      }
    } else {
      store.set('player.subtitleStyle', clean);
    }
    this.subs.setStyle(this.subtitlePrefs());
  }

  async openEpisodes() {
    const pb = this.playback;
    if (!pb || pb.title?.type !== 'series') return;
    const list = h('div', { class: 'lm-player__episodes' }, spinner('Loading episodes'));
    this.openPlayerDialog({ title: pb.title.title, content: list, side: true, className: 'lm-player__dialog--episodes' });
    try {
      this.titleDetail ??= await (this.o.fetchTitle ? this.o.fetchTitle() : api.catalog.title(pb.titleId));
      let progress = {};
      if (this.profile && !this.party) {
        try {
          const r = await api.library.titleProgress(pb.titleId);
          for (const p of r.items || []) progress[p.episodeId || ''] = p;
        } catch {
          progress = {};
        }
      }
      this.renderEpisodes(list, this.titleDetail, progress);
    } catch (err) {
      list.replaceChildren(h('p', { class: 'lm-player__hint' }, err?.message || 'Episodes could not be loaded.'));
    }
  }

  renderEpisodes(container, detail, progress) {
    const current = this.playback.episode;
    let season = current?.seasonNumber ?? detail.seasons?.[0]?.number;
    const listEl = h('ol', { class: 'lm-player__ep-list', role: 'list' });
    const locked = this.party && !this.party.canControl();
    const paint = () => {
      const s = detail.seasons.find((x) => x.number === season) || detail.seasons[0];
      listEl.replaceChildren(...(s?.episodes || []).map((ep) => {
        const isCurrent = ep.id === current?.id;
        const p = progress[ep.id];
        const pct = p?.completed ? 100 : p?.durationS ? Math.round((p.positionS / p.durationS) * 100) : 0;
        const disabled = !ep.hasMedia || locked;
        return h('li', null, h('button', {
          type: 'button',
          class: ['lm-player__ep', isCurrent && 'is-current'],
          disabled: disabled && !isCurrent,
          'aria-current': isCurrent ? 'true' : undefined,
          onClick: () => {
            if (isCurrent) {
              this.dialog?.close();
              return;
            }
            this.dialog?.close();
            this.o.onEpisodeRequest?.(ep, { reason: 'drawer' });
          },
        },
        h('span', { class: 'lm-player__ep-art' }, ep.still ? h('img', { src: ep.still, alt: '', loading: 'lazy' }) : null, pct ? h('span', { class: 'lm-player__ep-progress', style: { width: `${pct}%` } }) : null),
        h('span', { class: 'lm-player__ep-text' },
          h('span', { class: 'lm-player__ep-num' }, `Episode ${ep.number}${ep.runtimeMin ? ` · ${ep.runtimeMin}m` : ''}`),
          h('span', { class: 'lm-player__ep-name' }, ep.name),
          isCurrent ? h('span', { class: 'lm-badge lm-badge--accent' }, 'Now playing') : !ep.hasMedia ? h('span', { class: 'lm-badge' }, 'Not available yet') : p?.completed ? h('span', { class: 'lm-badge lm-badge--ok' }, 'Watched') : null)));
      }));
    };
    const seasons = detail.seasons || [];
    const picker = seasons.length > 1
      ? h('select', { class: 'lm-select lm-player__season', 'aria-label': 'Season', onChange: (e) => { season = Number(e.target.value); paint(); } },
        ...seasons.map((s) => h('option', { value: String(s.number), selected: s.number === season }, s.name || `Season ${s.number}`)))
      : null;
    paint();
    container.replaceChildren(...[picker, locked ? h('p', { class: 'lm-player__hint' }, 'The host chooses episodes in this party.') : null, listEl].filter(Boolean));
    container.querySelector('.is-current')?.scrollIntoView?.({ block: 'center' });
  }

  async openReport(category) {
    if (this.isFullscreen()) await this.exitFullscreen();
    const { openQualityReport } = await import('../ui/panels/quality-panel.js');
    this.saveDiagnostics();
    const pb = this.playback;
    openQualityReport(pb?.title || { id: pb?.titleId, title: this.titleEl.textContent }, pb?.episode || null, { category, selectedResolution: this.qualitySummary() });
  }

  // ───────────────────────────── Stats for nerds ─────────────────────────────
  toggleStats(force) {
    this.statsVisible = force ?? !this.statsVisible;
    this.statsEl.hidden = !this.statsVisible;
    if (this.statsVisible) this.renderStats();
    this.announce(this.statsVisible ? 'Stats for nerds shown' : 'Stats for nerds hidden');
  }

  statsData() {
    const v = this.video;
    const e = this.engine;
    const q = v.getVideoPlaybackQuality?.();
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
    const tel = this.telemetry;
    const sub = this.subs.selectedInfo;
    const audio = (e?.audioTracks() || []).find((t) => t.selected);
    return {
      source: e ? e.label : '—',
      host: e?.host || '—',
      resolution: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—',
      quality: this.qualitySummary(),
      viewport: `${Math.round(this.root.clientWidth)}×${Math.round(this.root.clientHeight)} @${window.devicePixelRatio || 1}x`,
      currentBitrate: H.formatBitrate(e?.currentBitrate()),
      measuredBitrate: H.formatBitrate(e?.measuredBitrate?.()),
      bandwidth: H.formatBitrate(e?.bandwidthEstimate()),
      buffer: `${ahead.toFixed(1)} s`,
      frames: q ? `${q.droppedVideoFrames} dropped of ${q.totalVideoFrames}` : 'Not reported by this browser',
      codecs: e?.codecs() || 'Not reported for this source',
      audio: audio ? this.audioLabel(audio) : '—',
      subtitles: sub ? sub.label : 'Off',
      startup: tel?.startupMs !== null && tel?.startupMs !== undefined ? `${tel.startupMs} ms` : '—',
      rebuffers: tel ? `${tel.rebufferCount} (${tel.rebufferSeconds.toFixed(1)} s)` : '—',
      // Issued by the server once loading starts; never issued in Preview mode.
      session: tel?.sessionId ? tel.sessionId.slice(0, 8) : '—',
      ahead,
      q,
    };
  }

  renderStats() {
    if (!this.statsVisible) return;
    const s = this.statsData();
    const rows = [
      ['Source', `${s.source} · ${s.host}`],
      ['Resolution', `${s.resolution} (${s.quality})`],
      ['Viewport', s.viewport],
      ['Current bitrate', `${s.currentBitrate}${this.engine?.type === 'hls.js' ? ' (declared)' : ''}`],
      ['Estimated bitrate', `${s.measuredBitrate}${s.measuredBitrate !== '—' ? ' (measured)' : ''}`],
      ['Bandwidth estimate', s.bandwidth],
      ['Buffer ahead', s.buffer],
      ['Frames', s.frames],
      ['Codecs', s.codecs],
      ['Audio', s.audio],
      ['Subtitles', s.subtitles],
      ['Startup', s.startup],
      ['Rebuffering', s.rebuffers],
      ['Session', s.session],
    ];
    if (!this.statsList) {
      this.statsList = h('dl', { class: 'lm-player__stats-list' });
      this.statsEl.replaceChildren(
        h('div', { class: 'lm-player__stats-head' },
          h('strong', null, 'Stats for nerds'),
          h('button', { type: 'button', class: 'lm-player__btn lm-player__btn--sm', 'aria-label': 'Close stats', onClick: () => this.toggleStats(false) }, icon('close'))),
        this.statsList,
        h('p', { class: 'lm-player__stats-note' }, 'Measured on this device. Not shared unless you attach it to a report.'));
    }
    this.statsList.replaceChildren(...rows.flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)]));
  }

  saveDiagnostics() {
    if (!this.telemetry || !this.playback) return;
    const s = this.statsData();
    this.telemetry.saveDiagnostics({
      source: this.engine?.type || this.sources[this.sourceIndex]?.kind,
      host: this.engine?.host,
      resolution: s.resolution !== '—' ? s.resolution : undefined,
      quality: s.quality,
      bandwidthKbps: this.engine?.bandwidthEstimate() ? Math.round(this.engine.bandwidthEstimate() / 1000) : undefined,
      bufferAheadS: Math.round(s.ahead * 10) / 10,
      codecs: this.engine?.codecs() || undefined,
      audio: s.audio !== '—' ? s.audio : undefined,
      subtitles: s.subtitles,
    });
  }

  // ───────────────────────────── Fullscreen & PiP ─────────────────────────────
  isFullscreen() {
    return (document.fullscreenElement || document.webkitFullscreenElement) === this.root;
  }

  async exitFullscreen() {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else document.webkitExitFullscreen?.();
    } catch {
      /* ignore */
    }
  }

  async toggleFullscreen() {
    if (this.isFullscreen()) {
      await this.exitFullscreen();
      return;
    }
    const req = this.root.requestFullscreen || this.root.webkitRequestFullscreen;
    if (req) {
      try {
        await req.call(this.root, { navigationUI: 'hide' });
        await screen.orientation?.lock?.('landscape').catch(() => {});
      } catch {
        if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
      }
    } else if (this.video.webkitEnterFullscreen) {
      // iOS Safari: only the video element can go fullscreen (native controls/captions).
      this.video.webkitEnterFullscreen();
    }
  }

  onFullscreenChange() {
    const fs = this.isFullscreen();
    this.root.dataset.fullscreen = String(fs);
    this.fsBtn.setIcon(fs ? 'fullscreenExit' : 'fullscreen');
    this.fsBtn.setLabel(fs ? 'Exit full screen (f)' : 'Full screen (f)');
    if (!fs) screen.orientation?.unlock?.();
    this.showControls();
  }

  pipSupported() {
    const v = document.createElement('video');
    return (!!document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') || typeof v.webkitSetPresentationMode === 'function';
  }

  async togglePip() {
    const v = this.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch {
      this.notify('Picture in picture is not available right now', 'pip');
    }
  }

  // ───────────────────────────── Keyboard ─────────────────────────────
  onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || this.destroyed) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (t?.closest?.('.lm-player__menu, .lm-player__dialog') || document.querySelector('#lm-modals dialog[open]')) return;
    if (!this.root.isConnected) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const onControl = t?.closest?.('button, a[href], [role="slider"]');
    const handled = () => {
      e.preventDefault();
      this.showControls();
    };
    if (this.errorShown && key !== 'Escape' && key !== 'f') return;

    if (key === ' ' || key === 'Spacebar') {
      if (onControl && !this.pointerFocus) return; // keyboard users activate the focused button
      handled();
      this.togglePlay('user');
      return;
    }
    if ((key === 'Enter') && onControl) return;
    switch (key) {
      case 'k': handled(); this.togglePlay('user'); break;
      case 'ArrowLeft': case 'j': handled(); this.seekBy(-H.SEEK_STEP_S, 'user'); break;
      case 'ArrowRight': case 'l': handled(); this.seekBy(H.SEEK_STEP_S, 'user'); break;
      case 'ArrowUp': handled(); this.setVolume((this.video.muted ? 0 : this.video.volume) + 0.05); this.notify(`Volume ${Math.round(this.video.volume * 100)}%`, 'volume', 900); break;
      case 'ArrowDown': handled(); this.setVolume((this.video.muted ? 0 : this.video.volume) - 0.05); this.notify(`Volume ${Math.round(this.video.volume * 100)}%`, 'volumeLow', 900); break;
      case 'm': handled(); this.toggleMute(); break;
      case 'f': handled(); this.toggleFullscreen(); break;
      case 'c': handled(); this.toggleCaptions(); break;
      case 'p': if (this.pipSupported()) { handled(); this.togglePip(); } break;
      case 'n': if (this.playback?.next && !this.nextBtn.hidden) { handled(); this.playNext('key'); } break;
      case 's': if (!this.skipIntroBtn.hidden) { handled(); this.skipIntro(false); } else if (!this.skipCreditsBtn.hidden) { handled(); this.skipCredits(); } break;
      case 'i': handled(); this.toggleStats(); break;
      case '?': handled(); this.openShortcuts(); break;
      case '>': handled(); this.stepSpeed(1); break;
      case '<': handled(); this.stepSpeed(-1); break;
      case 'Escape':
        if (this.anyMenuOpen()) {
          handled();
          for (const m of Object.values(this.menus)) m.close({ focusTrigger: true });
        } else if (this.statsVisible) {
          handled();
          this.toggleStats(false);
        } else if (this.keyboardFocusInChrome() && !this.video.paused) {
          // Put the controls away for keyboard users; Tab brings them back.
          e.preventDefault();
          document.activeElement.blur();
          this.hideControls();
        }
        break;
      default:
        if (/^[0-9]$/.test(key) && this.duration()) {
          handled();
          this.seekTo((Number(key) / 10) * this.duration(), 'user');
        }
    }
  }

  goBack() {
    if (this.o.onBack) this.o.onBack();
    else if (this.playback) navigate(`/title/${encodeURIComponent(this.playback.titleId)}`);
    else history.back();
  }

  // ───────────────────────────── Party ─────────────────────────────
  /** Disables play/seek controls for party guests who cannot control playback. */
  applyPartyLock() {
    const locked = !!this.party && !this.party.canControl();
    this.root.classList.toggle('is-locked', locked);
    const reason = locked ? 'The host controls playback' : null;
    // While the party plays and this guest is paused (autoplay blocked, or they fell
    // behind), Play stays available: it starts locally and rejoins the party timeline.
    const catchUp = locked && this.canCatchUp();
    for (const b of [this.playBtn, this.bigPlay, this.back10Btn, this.fwd10Btn, this.centerBack, this.centerFwd, this.nextBtn]) {
      const off = locked && !(catchUp && (b === this.playBtn || b === this.bigPlay));
      b.setAttribute('aria-disabled', String(off));
      if (off) b.dataset.tip = reason;
      else if (b.dataset.tip === reason || b.dataset.tip === 'The host controls playback') b.dataset.tip = b.getAttribute('aria-label') || '';
    }
    if (catchUp) {
      this.playBtn.setLabel('Play to join the party (k)');
      this.bigPlay.setAttribute('aria-label', 'Play to join the party');
    }
    this.seek.setDisabled(locked, reason);
  }

  /**
   * Follows the party timeline: play/pause and correct drift larger than 1.5 s.
   * Returns true when the local position had to be corrected.
   */
  syncTo({ playing, position }) {
    if (!this.playback || this.errorShown) return false;
    const v = this.video;
    let corrected = false;
    if (Number.isFinite(position) && H.needsResync(v.currentTime, position) && !this.engineLoading()) {
      const d = this.duration();
      // Past the end of this media: hold on the last frame instead of looping a seek.
      if (!d || position < d - 0.5 || !v.ended) {
        this.seekTo(position, 'remote');
        corrected = true;
      }
    }
    if (playing && v.paused && !v.ended) {
      if (this.endScreenShown) this.hideEndScreen();
      const p = v.play();
      p?.catch?.((err) => {
        if (err?.name === 'NotAllowedError' && !this.autoplayBlocked) {
          this.autoplayBlocked = true;
          this.setBuffering(false);
          this.revealVideo();
          this.updatePlayState();
          this.notify('Press play to join the party playback', 'play', 5000);
        }
      });
    } else if (!playing && !v.paused) {
      v.pause();
    }
    this.updatePlayState();
    return corrected;
  }

  /** True until the current source has metadata (seeking before that is not meaningful). */
  engineLoading() {
    return !this.engine || this.video.readyState < 1;
  }

  // ───────────────────────────── Media Session ─────────────────────────────
  setupMediaSession() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const pb = this.playback;
    const t = pb.title || {};
    const art = t.backdrop || t.poster;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: pb.episode ? pb.episode.name : t.title,
        artist: pb.episode ? `${t.title} · ${H.episodeLabel(pb.episode).split(' · ')[0]}` : 'Lumina',
        album: 'Lumina',
        artwork: art ? [{ src: new URL(art, location.href).href }] : [],
      });
      const set = (action, fn) => {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch {
          /* unsupported action */
        }
      };
      set('play', () => this.play('user'));
      set('pause', () => this.pause('user'));
      set('seekbackward', () => this.seekBy(-H.SEEK_STEP_S, 'user'));
      set('seekforward', () => this.seekBy(H.SEEK_STEP_S, 'user'));
      set('seekto', (d) => this.seekTo(d.seekTime, 'user'));
      set('nexttrack', pb.next ? () => this.playNext('media-key') : null);
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────────── Ticker ─────────────────────────────
  tick() {
    if (this.destroyed) return;
    const v = this.video;
    const nowT = performance.now();
    // Watchdog: playback wanted but the clock is not moving.
    const wants = !!this.playback && !this.errorShown && !v.paused && !v.ended && !this.autoplayBlocked;
    if (!wants || Math.abs(v.currentTime - this.watchT) > 0.05) {
      this.watchT = v.currentTime;
      this.progressAt = nowT;
      this.hideStallHint();
    } else {
      const stalled = nowT - this.progressAt;
      if (stalled > STALL_HINT_MS) this.showStallHint();
      if (stalled > STALL_ERROR_MS) {
        this.progressAt = nowT;
        this.hideStallHint();
        this.onEngineError(new PlaybackError('stalled', 'Playback made no progress for 20 seconds.', { code: 'STALL_TIMEOUT' }));
      }
    }
    if (this.telemetry && this.engine) {
      this.telemetry.sampleFrames(v);
      this.telemetry.setBytes(this.engine.bytesLoaded);
    }
    if (!v.paused && this.started && nowT - this.lastSaveAt >= SAVE_EVERY_MS) this.saveProgress('interval');
    this.tickCount = (this.tickCount || 0) + 1;
    if (this.tickCount % 5 === 0) this.saveDiagnostics();
    this.nextCard?.tick();
    if (this.statsVisible) this.renderStats();
    if (this.engine?.isAuto) this.updateQualityUi();
  }

  // ───────────────────────────── Teardown ─────────────────────────────
  destroy() {
    if (this.destroyed) return;
    const saving = this.finishMedia({ reason: 'exit' });
    Promise.resolve(saving).finally(() => refreshLibrary());
    this.destroyed = true;
    clearInterval(this.tickTimer);
    clearTimeout(this.hideTimer);
    clearTimeout(this.seekSaveTimer);
    clearTimeout(this.resumeTimer);
    clearTimeout(this.tapTimer);
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    for (const m of Object.values(this.menus)) m.destroy();
    this.dialog?.close();
    if (this.isFullscreen()) this.exitFullscreen();
    if (document.pictureInPictureElement === this.video) document.exitPictureInPicture().catch(() => {});
    this.teardownEngine();
    this.subs.destroy();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack']) navigator.mediaSession.setActionHandler(a, null);
      } catch {
        /* ignore */
      }
    }
    bus.emit('player:active', false);
  }
}

function sessionStorageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionStorageSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
