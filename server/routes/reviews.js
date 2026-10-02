// Community: reviews, helpful votes, replies, reports and blocks (docs/API.md "Community").
import { requireAuth, requireProfile } from '../auth/session.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { COMMENT_BODY_MAX, REPORT_REASONS, REVIEW_BODY_MAX, ReviewService } from '../services/reviews.js';

const reviewCreate = v.object({
  rating: v.int().min(1).max(5),
  body: v.string().max(REVIEW_BODY_MAX).nullable().optional(),
  containsSpoilers: v.boolean().default(false),
});

const reviewPatch = v.object({
  rating: v.int().min(1).max(5).optional(),
  body: v.string().max(REVIEW_BODY_MAX).nullable().optional(),
  containsSpoilers: v.boolean().optional(),
});

const commentCreate = v.object({ body: v.string().min(1).max(COMMENT_BODY_MAX) });

const reportCreate = v.object({
  targetType: v.enum(['review', 'comment', 'collection']),
  targetId: v.string().max(80),
  reason: v.enum(REPORT_REASONS),
  details: v.string().max(1000).optional(),
});

const blockCreate = v.object({ reviewId: v.string().max(80) });

const byAccount = 'account';

export default function register(app, { db, services, config }) {
  services.reviews ??= new ReviewService(db, services.catalog, config);
  const reviews = services.reviews;

  app.get('/api/titles/:id/reviews', rateLimit('reviews:list', { max: 240, windowMs: 60_000 }), (ctx) => reviews.list(ctx, ctx.params.id, ctx.query));

  app.post('/api/titles/:id/reviews', requireProfile, rateLimit('reviews:create', { max: 30, windowMs: 60 * 60_000, by: byAccount }), async (ctx) => {
    const input = v.parse(reviewCreate, await ctx.body());
    return reviews.create(ctx, ctx.params.id, input);
  });

  app.patch('/api/reviews/:id', requireProfile, rateLimit('reviews:edit', { max: 60, windowMs: 60 * 60_000, by: byAccount }), async (ctx) => {
    const raw = await ctx.body();
    const input = v.parse(reviewPatch, raw);
    // An explicitly blank body clears the written review (keeping the rating).
    if ('body' in raw && input.body === undefined) input.body = null;
    return reviews.update(ctx, ctx.params.id, input);
  });

  app.delete('/api/reviews/:id', requireProfile, (ctx) => {
    reviews.remove(ctx, ctx.params.id);
  });

  const vote = (on) => (ctx) => reviews.vote(ctx, ctx.params.id, on);
  app.put('/api/reviews/:id/helpful', requireAuth, rateLimit('reviews:vote', { max: 200, windowMs: 10 * 60_000, by: byAccount }), vote(true));
  app.delete('/api/reviews/:id/helpful', requireAuth, rateLimit('reviews:vote', { max: 200, windowMs: 10 * 60_000, by: byAccount }), vote(false));

  app.get('/api/reviews/:id/comments', rateLimit('comments:list', { max: 240, windowMs: 60_000 }), (ctx) => reviews.comments(ctx, ctx.params.id));

  app.post('/api/reviews/:id/comments', requireProfile, rateLimit('comments:create', { max: 40, windowMs: 10 * 60_000, by: byAccount }), async (ctx) => {
    const { body } = v.parse(commentCreate, await ctx.body());
    return reviews.addComment(ctx, ctx.params.id, body);
  });

  app.delete('/api/comments/:id', requireProfile, (ctx) => {
    reviews.removeComment(ctx, ctx.params.id);
  });

  app.post('/api/reports', requireAuth, rateLimit('reports', { max: 30, windowMs: 60 * 60_000, by: byAccount }), async (ctx) => {
    const input = v.parse(reportCreate, await ctx.body());
    return reviews.report(ctx, input);
  });

  app.get('/api/blocks', requireAuth, (ctx) => reviews.blocks(ctx));

  app.post('/api/blocks', requireAuth, rateLimit('blocks', { max: 60, windowMs: 60 * 60_000, by: byAccount }), async (ctx) => {
    const { reviewId } = v.parse(blockCreate, await ctx.body());
    return reviews.block(ctx, reviewId);
  });

  app.delete('/api/blocks/:id', requireAuth, (ctx) => {
    reviews.unblock(ctx, ctx.params.id);
  });
}
