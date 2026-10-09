// Subtitles and captions. Lumina draws cues itself so the viewer's style preferences (size,
// colour, background, position) apply everywhere: every text track stays in mode "hidden"
// (cues load and `cuechange` fires, but the browser paints nothing) and the active cues are
// rendered into an overlay as text nodes (see parseCueText — cue markup never becomes HTML).
//
// Tracks come from two real sources only: sidecar WebVTT files listed on the media
// (appended as <track> elements) and text tracks the stream exposes (hls.js creates these
// for EXT-X-MEDIA subtitle renditions and CEA-608 captions).
import { h, clear } from '../core/dom.js';
import { languageName } from '../core/format.js';
import { parseCueText, subtitleStyle } from './helpers.js';

const TEXT_KINDS = new Set(['subtitles', 'captions']);

function isCrossOrigin(src) {
  try {
    return new URL(src, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

export class SubtitleManager {
  constructor(video, overlay, { onChange, onError } = {}) {
    this.video = video;
    this.overlay = overlay;
    this.onChange = onChange;
    this.onError = onError;
    this.trackEls = [];
    this.selected = null; // TextTrack
    this.failed = new WeakSet();
    this.style = subtitleStyle({});
    this.onCue = () => this.render();
    this.onListChange = () => {
      this.enforceModes();
      this.onChange?.();
    };
    video.textTracks.addEventListener('addtrack', this.onListChange);
    video.textTracks.addEventListener('removetrack', this.onListChange);
    // hls.js flips modes when it creates tracks; keep ours authoritative.
    this.onModeChange = () => this.enforceModes();
    video.textTracks.addEventListener('change', this.onModeChange);
  }

  /** Adds the media's sidecar WebVTT tracks. Returns true if any is cross-origin. */
  addSidecars(tracks = []) {
    this.removeSidecars();
    let crossOrigin = false;
    const seen = new Set();
    for (const t of tracks) {
      if (!t?.src) continue;
      const key = `${t.lang}|${t.label}|${t.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isCrossOrigin(t.src)) crossOrigin = true;
      const el = h('track', {
        kind: t.kind === 'captions' ? 'captions' : 'subtitles',
        src: t.src,
        srclang: t.lang || undefined,
        label: t.label || languageName(t.lang) || 'Subtitles',
      });
      el.dataset.sidecar = '1';
      el.addEventListener('error', () => {
        this.failed.add(el.track);
        const wasSelected = this.selected === el.track;
        if (wasSelected) this.select(null);
        this.onError?.(el.track, wasSelected);
        this.onChange?.();
      });
      this.video.append(el);
      this.trackEls.push(el);
      el.track.mode = 'disabled';
    }
    return crossOrigin;
  }

  removeSidecars() {
    for (const el of this.trackEls) el.remove();
    this.trackEls = [];
  }

  /** Every usable text track: [{ id, track, lang, label, kind, sidecar }] */
  tracks() {
    const out = [];
    const seen = new Set();
    [...this.video.textTracks].forEach((track, i) => {
      if (!TEXT_KINDS.has(track.kind) || this.failed.has(track)) return;
      const sidecar = this.trackEls.some((el) => el.track === track);
      const label = track.label || languageName(track.language) || `Subtitles ${i + 1}`;
      const key = `${track.language}|${label}|${track.kind}|${sidecar}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: `t${i}`, index: i, track, lang: track.language || '', label: track.kind === 'captions' && !/\bCC\b|SDH|caption/i.test(label) ? `${label} (CC)` : label, kind: track.kind, sidecar });
    });
    return out;
  }

  get selectedId() {
    return this.tracks().find((t) => t.track === this.selected)?.id || 'off';
  }

  get selectedInfo() {
    return this.tracks().find((t) => t.track === this.selected) || null;
  }

  /** Selects a TextTrack (or null for off). */
  select(track) {
    if (this.selected) this.selected.removeEventListener('cuechange', this.onCue);
    this.selected = track || null;
    this.enforceModes();
    if (this.selected) this.selected.addEventListener('cuechange', this.onCue);
    this.render();
  }

  selectById(id) {
    const t = this.tracks().find((x) => x.id === id);
    this.select(t ? t.track : null);
    return t || null;
  }

  enforceModes() {
    for (const track of this.video.textTracks) {
      if (!TEXT_KINDS.has(track.kind)) continue;
      const want = track === this.selected ? (this.nativeMode ? 'showing' : 'hidden') : 'disabled';
      if (track.mode !== want) track.mode = want;
    }
  }

  /** In PiP or iOS native fullscreen our overlay is not visible: let the browser draw. */
  setNativeRendering(on) {
    this.nativeMode = !!on;
    this.enforceModes();
    this.render();
  }

  setStyle(prefs) {
    this.style = subtitleStyle(prefs);
    const o = this.overlay;
    for (const [k, v] of Object.entries(this.style.vars)) o.style.setProperty(k, v);
    o.dataset.background = this.style.background;
    o.dataset.position = this.style.position;
    o.dataset.size = this.style.size;
  }

  render() {
    const o = this.overlay;
    clear(o);
    const track = this.selected;
    if (!track || this.nativeMode || !track.activeCues) return;
    const cues = [...track.activeCues].sort((a, b) => a.startTime - b.startTime);
    for (const cue of cues) {
      const lines = parseCueText(cue.text || '');
      const block = h('div', { class: 'lm-subs__cue' });
      for (const line of lines) {
        const ln = h('span', { class: 'lm-subs__line' });
        line.forEach((seg) => {
          const el = h(seg.bold ? 'b' : 'span', { class: [seg.italic && 'is-italic', seg.underline && 'is-underline'] }, seg.text);
          ln.append(el);
        });
        block.append(ln);
      }
      o.append(block);
    }
  }

  /** Renders sample text for the appearance editor preview. */
  static preview(node, prefs) {
    const s = subtitleStyle(prefs);
    for (const [k, v] of Object.entries(s.vars)) node.style.setProperty(k, v);
    node.dataset.background = s.background;
    node.dataset.position = s.position;
    node.dataset.size = s.size;
  }

  destroy() {
    if (this.selected) this.selected.removeEventListener('cuechange', this.onCue);
    this.video.textTracks.removeEventListener('addtrack', this.onListChange);
    this.video.textTracks.removeEventListener('removetrack', this.onListChange);
    this.video.textTracks.removeEventListener('change', this.onModeChange);
    this.removeSidecars();
    clear(this.overlay);
  }
}
