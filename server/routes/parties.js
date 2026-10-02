// Watch parties (profile). In-memory and single-instance — see services/parties.js for the
// scaling notes. Every endpoint is gated by config.features.watchParties (FEATURE_WATCH_PARTIES).
//
//   POST   /api/parties                 {titleId, episodeId?}             → {code, party}
//   GET    /api/parties/:code                                             → {party}
//   POST   /api/parties/:code/join                                        → {party}
//   POST   /api/parties/:code/leave                                       → {ok, ended}
//   DELETE /api/parties/:code           (host)                            → {ok}
//   PATCH  /api/parties/:code           (host) {allowGuestControl}        → {party}
//   POST   /api/parties/:code/control   {action, position?, episodeId?}   → {state}
//   POST   /api/parties/:code/chat      {text}                            → {message}
//   GET    /api/parties/:code/events    Server-Sent Events: state, members, chat, ended
import { requireProfile } from '../auth/session.js';
import { HttpError } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { rateLimit } from '../lib/security.js';
import { PartyService, CODE_PATTERN } from '../services/parties.js';
import { declareSettingConsumer, readPlatformSettings } from '../services/admin/settings.js';

const HEARTBEAT_MS = 20_000;

const createSchema = v.object({
  titleId: v.string().max(80),
  episodeId: v.string().max(80).optional(),
});

const controlSchema = v.object({
  action: v.enum(['play', 'pause', 'seek', 'episode']),
  position: v.number().min(0).max(24 * 3600).optional(),
  episodeId: v.string().max(80).optional(),
});

const settingsSchema = v.object({ allowGuestControl: v.boolean() });

// Length is re-checked (after whitespace folding) by the service.
const chatSchema = v.object({ text: v.string().max(2000) });

export default function register(app, { db, services, config }) {
  services.parties ??= new PartyService();
  // The admin "Watch parties" switch stops new parties; rooms already open run to their end.
  declareSettingConsumer('watchPartiesEnabled');
  const { parties, catalog } = services;

  const enabled = () => {
    if (!config.features.watchParties) throw new HttpError(403, 'FEATURE_DISABLED', 'Watch parties are turned off on this Lumina server.');
  };
  const codeParam = (ctx) => {
    const code = PartyService.normalizeCode(ctx.params.code);
    if (!CODE_PATTERN.test(code)) throw new HttpError(404, 'PARTY_NOT_FOUND', 'This watch party has ended or the code is not valid.');
    return code;
  };
  const guard = [requireProfile, enabled];

  app.post('/api/parties', ...guard, rateLimit('party-create', { max: 12, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    if (!readPlatformSettings(db).watchPartiesEnabled) throw new HttpError(403, 'FEATURE_DISABLED', 'New watch parties are paused on this Lumina server.');
    const { titleId, episodeId } = v.parse(createSchema, await ctx.body());
    // Checks visibility, parental limits, entitlement and that there is something to play.
    const playback = catalog.playback(titleId, episodeId || null, { profile: ctx.profile, account: ctx.account });
    const room = parties.create({ titleId, episodeId: playback.episode?.id || null, profile: ctx.profile, accountId: ctx.account.id });
    return { code: room.code, party: parties.partyDto(room, ctx.profile.id) };
  });

  app.get('/api/parties/:code', ...guard, (ctx) => {
    const room = parties.require(codeParam(ctx));
    return { party: parties.partyDto(room, ctx.profile.id) };
  });

  app.post('/api/parties/:code/join', ...guard, rateLimit('party-join', { max: 30, windowMs: 60_000, by: 'account' }), (ctx) => {
    const code = codeParam(ctx);
    const room = parties.require(code);
    // Parental limits apply to guests too.
    catalog.detail(room.titleId, { profile: ctx.profile });
    parties.join(code, ctx.profile, ctx.account.id);
    return { party: parties.partyDto(room, ctx.profile.id) };
  });

  app.post('/api/parties/:code/leave', ...guard, (ctx) => {
    const { ended } = parties.leave(codeParam(ctx), ctx.profile.id);
    return { ok: true, ended };
  });

  app.delete('/api/parties/:code', ...guard, (ctx) => {
    parties.end(codeParam(ctx), ctx.profile.id);
    return { ok: true };
  });

  app.patch('/api/parties/:code', ...guard, async (ctx) => {
    const body = v.parse(settingsSchema, await ctx.body());
    const room = parties.setSettings(codeParam(ctx), ctx.profile.id, body);
    return { party: parties.partyDto(room, ctx.profile.id) };
  });

  app.post('/api/parties/:code/control', ...guard, rateLimit('party-control', { max: 180, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const body = v.parse(controlSchema, await ctx.body());
    const code = codeParam(ctx);
    const room = parties.require(code);
    parties.requireMember(room, ctx.profile.id);
    if (body.action === 'episode') {
      if (!body.episodeId) throw new HttpError(422, 'VALIDATION_FAILED', 'Choose an episode.', { fields: { episodeId: 'Required for this action.' } });
      // Must be a playable episode of this party's title.
      const pb = catalog.playback(room.titleId, body.episodeId, { profile: ctx.profile, account: ctx.account });
      if (!pb.episode || pb.episode.id !== body.episodeId) throw new HttpError(404, 'NOT_FOUND', 'That episode does not exist.');
    }
    return { state: parties.control(code, ctx.profile.id, body) };
  });

  app.post('/api/parties/:code/chat', ...guard, async (ctx) => {
    const { text } = v.parse(chatSchema, await ctx.body());
    return { message: parties.chat(codeParam(ctx), ctx.profile.id, text) };
  });

  // Server-Sent Events. EventSource sends same-origin cookies, so the session guard applies.
  app.get('/api/parties/:code/events', ...guard, (ctx) => {
    const code = codeParam(ctx);
    const room = parties.require(code);
    parties.requireMember(room, ctx.profile.id);

    const res = ctx.res;
    ctx.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.req.socket?.setTimeout?.(0);
    ctx.req.socket?.setNoDelay?.(true);
    let open = true;
    const write = (chunk) => {
      if (open && !res.writableEnded) res.write(chunk);
    };
    const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const close = () => {
      if (!open) return;
      open = false;
      if (!res.writableEnded) res.end();
    };
    write('retry: 3000\n\n');
    const unsubscribe = parties.subscribe(code, ctx.profile.id, { send, close });
    const heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', () => {
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
