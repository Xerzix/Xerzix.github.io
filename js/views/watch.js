// Watch page (/watch/:id). Query: episode=<id>, trailer=1, t=<seconds>.
// Immersive layout: the header, footer, garden and particles are hidden while it is open.
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { toastError } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { LuminaPlayer } from '../player/player.js';
import { parseTimeParam, episodeLabel } from '../player/helpers.js';

export default async function render(ctx) {
  const titleId = ctx.params.id;
  const trailer = ctx.query.get('trailer') === '1';
  const startAt = parseTimeParam(ctx.query.get('t'));
  let episodeId = ctx.query.get('episode') || undefined;
  const root = h('div', { class: 'lm-watch' });
  let titleDetail = null;
  const fetchTitle = async () => (titleDetail ??= await api.catalog.title(titleId));

  const partyButton = canStartParty(trailer)
    ? h('button', { type: 'button', class: 'lm-btn lm-btn--glass lm-btn--sm lm-player__party-start', onClick: () => startParty() }, icon('users'), h('span', null, 'Start watch party'))
    : null;

  const player = new LuminaPlayer({
    profile: session.profile,
    mode: api.mode,
    extras: partyButton ? [partyButton] : [],
    fetchTitle,
    onBack: () => ctx.navigate(`/title/${encodeURIComponent(titleId)}`),
    onEpisodeRequest: (ep, { reason }) => switchEpisode(ep, reason),
    onMediaChange: (pb) => {
      const label = pb.episode && !trailer ? `${pb.title.title} · ${episodeLabel(pb.episode).split(' · ')[0]}` : pb.title.title;
      ctx.setTitle(trailer ? `${pb.title.title} (Trailer)` : label);
    },
    onRetryLoad: () => load(),
  });
  root.append(player.el);
  ctx.onDestroy(() => player.destroy());

  async function load() {
    try {
      const playback = await api.catalog.playback(titleId, { episodeId, role: trailer ? 'trailer' : undefined });
      if (ctx.signal.aborted) return;
      episodeId = playback.episode?.id || episodeId;
      await player.load(playback, { startAt, trailer });
    } catch (err) {
      if (err?.name === 'AbortError' || ctx.signal.aborted) return;
      let name = null;
      try {
        name = (await fetchTitle()).title;
      } catch {
        /* the title itself may be the problem */
      }
      player.showError(err, { title: name || 'Lumina' });
    }
  }

  /** Next episode / episodes drawer: swap media in place (keeps fullscreen), update the URL. */
  async function switchEpisode(ep, reason) {
    try {
      const playback = await api.catalog.playback(titleId, { episodeId: ep.id });
      if (ctx.signal.aborted) return;
      episodeId = playback.episode?.id || ep.id;
      const hash = `#/watch/${encodeURIComponent(titleId)}?episode=${encodeURIComponent(episodeId)}`;
      history.replaceState({ ...(history.state || {}) }, '', hash);
      await player.load(playback, { startAt: reason === 'autoplay' ? 0 : null });
    } catch (err) {
      toastError(err);
      player.notify(err?.message || 'That episode could not be loaded', 'alert');
    }
  }

  async function startParty() {
    partyButton.disabled = true;
    try {
      const { code } = await api.parties.create({ titleId, episodeId: player.playback?.episode?.id || episodeId });
      ctx.navigate(`/party/${code}`);
    } catch (err) {
      partyButton.disabled = false;
      player.notify(err?.message || 'The watch party could not be started', 'alert', 5000);
    }
  }

  load();
  return root;
}

function canStartParty(trailer) {
  return !trailer && session.isServer && !!session.account && !!session.profile && session.features?.watchParties !== false && !!session.features?.watchParties;
}
