// Velvia Suggestions: a catalog-grounded film concierge.
//   GET  /api/velvia/status  public  { provider, available, model, grounded: true }
//   POST /api/velvia/chat    public  (profile optional; anonymous viewers get no personalisation)
import { v, patterns } from '../lib/validate.js';
import { rateLimit } from '../lib/security.js';
import { validation } from '../lib/errors.js';
import { VelviaService } from '../services/velvia/index.js';

const MAX_BODY_BYTES = 256 * 1024;

const chatSchema = v.object({
  messages: v.array(v.object({
    role: v.enum(['user', 'assistant']),
    content: v.string().max(2000),
  })).min(1).max(20),
  context: v.object({
    titleId: v.string().pattern(patterns.id, 'Unknown title.').optional(),
    compareIds: v.array(v.string().pattern(patterns.id, 'Unknown title.')).max(3).unique().optional(),
  }).optional(),
  options: v.object({
    useHistory: v.boolean().optional(),
  }).optional(),
});

export default function register(app, { services, config }) {
  services.velvia ??= new VelviaService({ catalog: services.catalog, library: services.library, config });
  const velvia = services.velvia;

  app.get('/api/velvia/status', () => velvia.status());

  app.post('/api/velvia/chat', rateLimit('velvia', { max: 20, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const body = v.parse(chatSchema, await ctx.body(MAX_BODY_BYTES));
    if (body.messages[body.messages.length - 1].role !== 'user') {
      throw validation({ messages: 'The last message must come from the viewer.' });
    }
    return velvia.chat({ body: { messages: body.messages, context: body.context || {}, options: body.options || {} }, profile: ctx.profile });
  });
}
