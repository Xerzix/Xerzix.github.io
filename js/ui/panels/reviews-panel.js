// Ratings & reviews panel for the title page. Contract: reviewsPanel(title) → Node (section#reviews).
// Everything is built with h() (text only, never HTML). Posts held by the spam filter or by
// member reports are shown honestly to their author and hidden from everyone else by the server.
import { h, announce, newUid } from '../../core/dom.js';
import { api, ServerRequiredError } from '../../api/client.js';
import { session } from '../../core/session.js';
import { relativeTime, date, plural } from '../../core/format.js';
import { icon } from '../icons.js';
import { avatar } from '../avatars.js';
import {
  button, linkButton, withBusy, toast, toastError, openModal, confirmDialog, bindMenu, menuItem,
  notice, stars, starInput, loading, errorState, sectionHead, checkbox,
} from '../components.js';

const BODY_MAX = 5000;
const REPLY_MAX = 1000;
const PAGE_SIZE = 8;
const SORTS = [
  { value: 'helpful', label: 'Most helpful' },
  { value: 'newest', label: 'Newest' },
  { value: 'highest', label: 'Highest rated' },
  { value: 'lowest', label: 'Lowest rated' },
];
export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam or advertising', hint: 'Links, promotions or repeated text.' },
  { value: 'harassment', label: 'Harassment or bullying', hint: 'Targets or insults a person.' },
  { value: 'hate', label: 'Hate speech', hint: 'Attacks people for who they are.' },
  { value: 'spoilers', label: 'Unmarked spoilers', hint: 'Reveals plot points without the spoiler flag.' },
  { value: 'sexual', label: 'Sexual content', hint: 'Explicit or inappropriate material.' },
  { value: 'violence', label: 'Violence or threats', hint: 'Threatens or glorifies harm.' },
  { value: 'misinformation', label: 'Misleading information', hint: 'False claims presented as fact.' },
  { value: 'copyright', label: 'Copyright', hint: 'Copies someone else’s writing.' },
  { value: 'other', label: 'Something else', hint: 'Tell us more below.' },
];

const signInHref = (titleId) => `#/login?next=${encodeURIComponent(`/title/${titleId}`)}`;

/** Textarea with a live "n / max" counter. Returns { wrap, control, counter }. */
function countedTextarea({ label, name, value = '', max, rows = 5, placeholder, hint }) {
  const id = newUid('txt');
  const counterId = `${id}-count`;
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  const describedBy = (withError) => [hintId, counterId, withError ? errId : null].filter(Boolean).join(' ');
  const control = h('textarea', { id, name, class: 'lm-textarea', rows, maxlength: max, placeholder, 'aria-describedby': describedBy(false) });
  control.value = value || '';
  const counter = h('span', { class: 'lm-counter', id: counterId });
  const paint = () => {
    const n = control.value.length;
    counter.textContent = `${n.toLocaleString()} / ${max.toLocaleString()}`;
    counter.classList.toggle('is-near', n > max * 0.9);
  };
  control.addEventListener('input', paint);
  paint();
  // role="alert" reads the message out when it appears; aria-describedby ties it to the field.
  const err = h('span', { class: 'lm-error-text', id: errId, role: 'alert', hidden: true });
  const wrap = h('div', { class: 'lm-field' },
    h('label', { class: 'lm-label', for: id }, label),
    control,
    h('div', { class: 'lm-field__foot' }, hint ? h('span', { class: 'lm-hint', id: hintId }, hint) : h('span'), counter),
    err);
  wrap.control = control;
  wrap.setError = (msg) => {
    wrap.classList.toggle('has-error', !!msg);
    control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    control.setAttribute('aria-describedby', describedBy(!!msg));
    err.hidden = !msg;
    err.textContent = msg || '';
  };
  return wrap;
}

/** Big average, stars and the 5→1 distribution bars. */
function summaryBlock(summary) {
  const count = summary?.count || 0;
  const avg = summary?.average;
  const dist = summary?.distribution || {};
  const bars = h('ul', { class: 'lm-dist', 'aria-label': 'Rating distribution' });
  for (let s = 5; s >= 1; s--) {
    const n = dist[s] || 0;
    const pct = count ? Math.round((n / count) * 100) : 0;
    bars.append(h('li', { class: 'lm-dist__row' },
      h('span', { class: 'lm-dist__label', 'aria-hidden': 'true' }, String(s), icon('star', { size: 12 })),
      h('span', { class: 'lm-dist__bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })),
      h('span', { class: 'lm-dist__count', 'aria-hidden': 'true' }, n.toLocaleString()),
      h('span', { class: 'visually-hidden' }, `${s} star${s > 1 ? 's' : ''}: ${plural(n, 'rating')} (${pct}%)`)));
  }
  return h('div', { class: 'lm-rating-summary' },
    h('div', { class: 'lm-rating-summary__score' },
      h('span', { class: 'lm-rating-summary__avg' }, count ? avg.toFixed(1) : '—'),
      h('div', null,
        stars(count ? avg : 0, { size: 'lg', label: count ? `Average ${avg.toFixed(1)} out of 5` : 'No ratings yet' }),
        h('p', { class: 'lm-rating-summary__count' }, count ? `${plural(count, 'member rating')}` : 'No member ratings yet'))),
    bars);
}

export function reviewsPanel(title) {
  const headingId = newUid('reviews');
  const root = h('section', { id: 'reviews', class: 'lm-reviews', 'aria-labelledby': headingId });
  const head = sectionHead('Ratings & reviews', { id: headingId, subtitle: 'What Lumina members think' });
  const summarySlot = h('div', { class: 'lm-reviews__summary lm-panel' }, loading('Loading ratings…'));
  const composerSlot = h('div', { class: 'lm-reviews__composer' });
  const toolbar = h('div', { class: 'lm-reviews__toolbar' });
  const list = h('div', { class: 'lm-reviews__list', 'aria-live': 'polite', 'aria-busy': 'true' });
  const more = h('div', { class: 'lm-reviews__more' });
  root.append(head, h('div', { class: 'lm-reviews__layout' },
    h('div', { class: 'lm-reviews__aside' }, summarySlot),
    h('div', { class: 'lm-reviews__main' }, composerSlot, toolbar, list, more)));

  const state = { sort: 'helpful', page: 1, total: 0, items: [], mine: null, editing: false, commentsEnabled: session.features?.reviewComments !== false };
  const canInteract = () => session.isServer && session.isSignedIn && !!session.profile;

  // ── Loading ──
  async function load({ reset = true } = {}) {
    if (reset) {
      state.page = 1;
      list.setAttribute('aria-busy', 'true');
    }
    let data;
    try {
      data = await api.reviews.list(title.id, { sort: state.sort, page: state.page, pageSize: PAGE_SIZE });
    } catch (err) {
      if (err instanceof ServerRequiredError) return renderPreview();
      summarySlot.replaceChildren(errorState(err, { retry: () => load() }));
      list.replaceChildren();
      list.setAttribute('aria-busy', 'false');
      return;
    }
    if (data?.unavailable) return renderPreview();
    state.total = data.total;
    state.mine = data.mine;
    if (typeof data.commentsEnabled === 'boolean') state.commentsEnabled = data.commentsEnabled;
    state.items = reset ? data.items : [...state.items, ...data.items];
    summarySlot.replaceChildren(summaryBlock(data.summary));
    if (reset) renderComposer();
    renderToolbar();
    if (reset) list.replaceChildren(...data.items.map(reviewCard));
    else list.append(...data.items.map(reviewCard));
    if (!state.items.length) {
      list.replaceChildren(h('p', { class: 'lm-reviews__empty' }, data.summary?.count
        ? 'No written reviews yet — only star ratings so far.'
        : `No one has reviewed ${title.title} yet.`));
    }
    list.setAttribute('aria-busy', 'false');
    renderMore();
  }

  function renderPreview() {
    summarySlot.replaceChildren(h('div', { class: 'lm-reviews__preview' },
      icon('lantern', { size: 32 }),
      h('p', null, h('strong', null, 'Reviews live on the Lumina server.')),
      h('p', { class: 'lm-muted lm-small' }, 'This copy of Lumina is running in Preview mode on static hosting. Member ratings, written reviews and replies appear when Lumina runs with its server — nothing here is simulated.')));
    composerSlot.replaceChildren();
    toolbar.replaceChildren();
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    more.replaceChildren();
    root.classList.add('is-preview');
  }

  // ── Composer / your review ──
  function renderComposer() {
    composerSlot.replaceChildren();
    if (!session.isSignedIn) {
      composerSlot.append(h('div', { class: 'lm-reviews__prompt lm-panel' },
        h('div', null, h('strong', null, `Seen ${title.title}?`), h('p', { class: 'lm-muted lm-small' }, 'Sign in to rate it and share what stayed with you.')),
        linkButton('Sign in to review', signInHref(title.id), { variant: 'primary', icon: 'star' })));
      return;
    }
    if (!session.profile) return;
    if (session.profile.isKids) {
      composerSlot.append(notice('Writing reviews is turned off on kids profiles.', { title: 'Reviews' }));
      return;
    }
    if (state.mine && !state.editing) {
      composerSlot.append(myReviewCard(state.mine));
      return;
    }
    composerSlot.append(composerForm(state.editing ? state.mine : null));
  }

  function statusNotice(review) {
    if (review.status === 'pending') return notice('Only you can see it until a moderator has looked at it. Nothing about your rating is counted until then.', { type: 'warn', title: 'Pending review' });
    if (review.status === 'hidden') return notice('This review is hidden while a moderator checks it. You can still delete it; a new review of this title from your account would also wait for a moderator.', { type: 'warn', title: 'Hidden for moderation' });
    if (review.status === 'removed') return notice('A moderator removed this review because it did not follow the Community Guidelines. You can delete it; a new review of this title from your account will be checked by a moderator before anyone else sees it.', { type: 'danger', title: 'Removed' });
    return null;
  }

  function myReviewCard(review) {
    const edit = button('Edit', { variant: 'ghost', size: 'sm', icon: 'edit', disabled: review.status === 'hidden' || review.status === 'removed' });
    const del = button('Delete', { variant: 'ghost', size: 'sm', icon: 'trash' });
    edit.addEventListener('click', () => {
      state.editing = true;
      renderComposer();
      composerSlot.querySelector('textarea')?.focus();
    });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete your review?', message: 'Your rating and written review for this title will be removed. Replies to it are deleted too.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api.reviews.remove(review.id);
        toast('Your review was deleted.', { type: 'success' });
        state.mine = null;
        await load();
      } catch (err) {
        toastError(err);
      }
    });
    // Your own review still shows how members responded: the helpful count and the replies.
    const actions = h('div', { class: 'lm-review__actions' });
    if (review.helpfulCount) {
      actions.append(h('span', { class: 'lm-review__helpful-count' }, icon('thumbsUp', { size: 16 }), `${plural(review.helpfulCount, 'member')} found this helpful`));
    }
    const replies = review.status === 'visible' || review.commentCount ? repliesThread(review) : null;
    if (replies) actions.append(replies.toggle);
    return h('div', { class: 'lm-reviews__mine lm-panel' },
      h('div', { class: 'lm-reviews__mine-head' },
        h('span', { class: 'lm-eyebrow' }, 'Your review'),
        h('div', { class: 'lm-cluster lm-cluster--sm' }, edit, del)),
      statusNotice(review),
      reviewBody(review, { own: true }),
      actions.childElementCount ? actions : null,
      replies?.thread);
  }

  function composerForm(existing) {
    let rating = existing?.rating || 0;
    const ratingErrId = newUid('rating-err');
    const ratingErr = h('span', { class: 'lm-error-text', id: ratingErrId, role: 'alert', hidden: true });
    const showRatingError = (msg) => {
      ratingErr.textContent = msg || '';
      ratingErr.hidden = !msg;
      if (msg) input.setAttribute('aria-describedby', ratingErrId);
      else input.removeAttribute('aria-describedby');
    };
    const input = starInput({ value: rating, label: 'Your rating', onChange: (v) => { rating = v; showRatingError(''); } });
    const body = countedTextarea({ label: 'Your review (optional)', name: 'body', value: existing?.body || '', max: BODY_MAX, rows: 5, placeholder: 'What stayed with you? Keep it kind and useful to others.', hint: 'Mark spoilers below so others can choose to reveal them.' });
    const spoiler = checkbox('This review contains spoilers', { name: 'containsSpoilers', checked: !!existing?.containsSpoilers });
    const submit = button(existing ? 'Save changes' : 'Post review', { variant: 'primary', type: 'submit', icon: existing ? 'check' : 'send' });
    const cancel = existing ? button('Cancel', { variant: 'ghost', onClick: () => { state.editing = false; renderComposer(); } }) : null;
    const form = h('form', { class: 'lm-form lm-reviews__form lm-panel', novalidate: true },
      h('div', { class: 'lm-reviews__form-head' },
        h('h3', { class: 'lm-h3' }, existing ? 'Edit your review' : 'Rate & review'),
        h('p', { class: 'lm-muted lm-small' }, `Posting as ${session.profile.name}`)),
      h('div', { class: 'lm-field' }, h('span', { class: 'lm-label', 'aria-hidden': 'true' }, 'Your rating'), input, ratingErr),
      body,
      spoiler,
      h('div', { class: 'lm-cluster' }, submit, cancel));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!rating) {
        showRatingError('Choose a rating from 1 to 5 stars.');
        input.querySelector('input')?.focus();
        return;
      }
      body.setError('');
      const payload = { rating, body: body.control.value.trim() || null, containsSpoilers: spoiler.querySelector('input').checked };
      withBusy(submit, async () => {
        try {
          const res = existing ? await api.reviews.update(existing.id, payload) : await api.reviews.create(title.id, payload);
          state.editing = false;
          state.mine = res.review;
          const held = res.review.status === 'pending';
          toast(held ? 'Saved. Your review is waiting for a moderator before others can see it.' : existing ? 'Your review was updated.' : 'Thank you — your review is live.', { type: held ? 'info' : 'success', timeout: held ? 7000 : 4200 });
          await load();
        } catch (err) {
          if (err.code === 'REVIEW_EXISTS') {
            await load();
            return;
          }
          if (err.fields?.body) body.setError(err.fields.body);
          else if (err.fields?.rating) showRatingError(err.fields.rating);
          else toastError(err);
        }
      });
    });
    return form;
  }

  // ── Toolbar & paging ──
  function renderToolbar() {
    const id = newUid('sort');
    const select = h('select', { id, class: 'lm-select lm-select--sm' }, ...SORTS.map((s) => h('option', { value: s.value, selected: s.value === state.sort }, s.label)));
    select.addEventListener('change', async () => {
      state.sort = select.value;
      await load();
      announce(`Reviews sorted by ${SORTS.find((s) => s.value === state.sort).label.toLowerCase()}`);
    });
    const blocked = session.isServer && session.isSignedIn ? button('Blocked members', { variant: 'ghost', size: 'sm', icon: 'eyeOff', onClick: openBlocks }) : null;
    toolbar.replaceChildren(
      h('p', { class: 'lm-reviews__total' }, state.total ? plural(state.total, 'written review') : 'Written reviews'),
      h('div', { class: 'lm-cluster lm-cluster--sm' }, blocked,
        h('label', { class: 'lm-reviews__sort', for: id }, h('span', { class: 'lm-small lm-muted' }, 'Sort'), select)));
    toolbar.hidden = !state.total && !state.items.length;
  }

  function renderMore() {
    more.replaceChildren();
    const shown = state.items.length;
    if (shown >= state.total) return;
    const btn = button(`Show more reviews (${(state.total - shown).toLocaleString()} more)`, { variant: 'glass', icon: 'chevronDown' });
    btn.addEventListener('click', () => withBusy(btn, async () => {
      const before = state.items.length;
      state.page += 1;
      await load({ reset: false });
      list.children[before]?.querySelector('h3, strong')?.closest('article')?.focus();
    }));
    more.append(btn);
  }

  // ── A review ──
  function reviewBody(review, { own = false } = {}) {
    const text = review.body ? h('p', { class: 'lm-review__text' }, review.body) : null;
    const meta = h('div', { class: 'lm-review__meta' },
      stars(review.rating, { label: `Rated ${review.rating} out of 5` }),
      h('time', { datetime: review.createdAt, title: date(review.createdAt) }, relativeTime(review.createdAt)),
      review.edited ? h('span', { class: 'lm-review__edited', title: review.editedAt ? `Edited ${date(review.editedAt)}` : undefined }, 'Edited') : null,
      review.containsSpoilers ? h('span', { class: 'lm-badge lm-badge--warn' }, 'Spoilers') : null);
    const headRow = h('div', { class: 'lm-review__head' },
      avatar(review.author.avatar, { className: 'lm-avatar lm-review__avatar' }),
      h('div', { class: 'lm-review__who' }, h('strong', { class: 'lm-review__name' }, own ? `${review.author.name} (you)` : review.author.name), meta));
    if (!text) return h('div', { class: 'lm-review__content' }, headRow, h('p', { class: 'lm-muted lm-small' }, 'Rated without a written review.'));
    if (!review.containsSpoilers || own) {
      return h('div', { class: 'lm-review__content' }, headRow, clampable(text));
    }
    // Spoilers: blurred and hidden from assistive tech until revealed.
    text.setAttribute('aria-hidden', 'true');
    text.tabIndex = -1;
    const cover = h('div', { class: 'lm-spoiler__cover' },
      h('span', null, icon('eyeOff', { size: 18 }), 'This review contains spoilers'),
      button('Reveal', { variant: 'glass', size: 'sm', icon: 'eye', onClick: () => {
        wrap.classList.remove('is-hidden');
        text.removeAttribute('aria-hidden');
        cover.remove();
        text.focus();
      } }));
    const wrap = h('div', { class: 'lm-spoiler is-hidden' }, text, cover);
    return h('div', { class: 'lm-review__content' }, headRow, wrap);
  }

  function clampable(text) {
    const wrap = h('div', { class: 'lm-review__clamp' }, text);
    if ((text.textContent || '').length < 420) return wrap;
    wrap.classList.add('is-clamped');
    const toggle = h('button', { type: 'button', class: 'lm-link lm-review__more', 'aria-expanded': 'false' }, 'Read more');
    toggle.addEventListener('click', () => {
      const open = wrap.classList.toggle('is-clamped') === false;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Show less' : 'Read more';
    });
    return h('div', null, wrap, toggle);
  }

  function reviewCard(review) {
    const article = h('article', { class: 'lm-review', tabindex: '-1', 'aria-label': `Review by ${review.author.name}, ${review.rating} out of 5` });
    const actions = h('div', { class: 'lm-review__actions' });

    // Helpful
    let voted = !!review.votedHelpful;
    let count = review.helpfulCount || 0;
    const helpful = h('button', { type: 'button', class: 'lm-btn lm-btn--ghost lm-btn--sm lm-review__helpful', 'aria-pressed': String(voted) });
    const paintHelpful = () => {
      helpful.replaceChildren(icon('thumbsUp'), h('span', null, count ? `Helpful · ${count.toLocaleString()}` : 'Helpful'));
      helpful.setAttribute('aria-pressed', String(voted));
      helpful.setAttribute('aria-label', `Mark as helpful. ${plural(count, 'member')} found this helpful.`);
    };
    paintHelpful();
    helpful.addEventListener('click', async () => {
      if (!canInteract()) {
        toast('Sign in to mark reviews as helpful.', { action: { label: 'Sign in', onClick: () => { location.hash = signInHref(title.id); } } });
        return;
      }
      const prev = [voted, count];
      voted = !voted;
      count += voted ? 1 : -1;
      paintHelpful();
      try {
        const r = await api.reviews.helpful(review.id, voted);
        count = r.helpfulCount;
        voted = r.voted;
        paintHelpful();
      } catch (err) {
        [voted, count] = prev;
        paintHelpful();
        toastError(err);
      }
    });
    const ownAccount = review.isMine || review.fromYourAccount;
    if (ownAccount) {
      helpful.disabled = true;
      helpful.title = 'Reviews from your own account cannot be marked as helpful.';
    }
    actions.append(helpful);

    // Replies
    const replies = repliesThread(review);
    if (replies) actions.append(replies.toggle);

    // Report / block (others' reviews, signed in)
    if (!ownAccount && canInteract()) {
      const trigger = h('button', { type: 'button', class: 'lm-btn lm-btn--ghost lm-btn--sm lm-btn--icon lm-review__menu-btn', 'aria-label': `More actions for ${review.author.name}’s review` }, icon('more'));
      // Close the menu and put focus back on its button before a dialog opens, so the dialog
      // returns focus there (not to a hidden menu item) when it closes.
      const fromMenu = (fn) => () => {
        menuCtl.close(true);
        fn();
      };
      const menu = h('div', { class: 'lm-menu lm-menu--up' },
        menuItem('Report review', { icon: 'flag', onClick: fromMenu(() => openReport('review', review.id, `${review.author.name}’s review`)) }),
        menuItem(`Block ${review.author.name}`, { icon: 'eyeOff', onClick: fromMenu(() => blockAuthor(review, article)) }));
      const menuCtl = bindMenu(trigger, menu);
      actions.append(h('span', { class: 'lm-spacer' }), h('div', { class: 'lm-popover-anchor' }, trigger, menu));
    }

    article.append(reviewBody(review), actions);
    if (replies) article.append(replies.thread);
    return article;
  }

  // ── Replies ──
  /** The "n replies" toggle and its (lazily loaded) thread, or null when replies are off. */
  function repliesThread(review) {
    if (!state.commentsEnabled) return null;
    const threadId = newUid('thread');
    let count = review.commentCount || 0;
    const toggle = h('button', { type: 'button', class: 'lm-btn lm-btn--ghost lm-btn--sm', 'aria-expanded': 'false', 'aria-controls': threadId });
    const paintToggle = () => toggle.replaceChildren(icon('message'), h('span', null, count ? plural(count, 'reply', 'replies') : 'Reply'));
    paintToggle();
    const thread = h('div', { class: 'lm-review__thread', id: threadId, hidden: true });
    let loaded = false;
    toggle.addEventListener('click', async () => {
      const open = thread.hidden;
      thread.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open && !loaded) {
        loaded = true;
        await renderThread(review, thread, (n) => {
          count = n;
          paintToggle();
        });
      }
      if (open) thread.querySelector('textarea')?.focus({ preventScroll: true });
    });
    return { toggle, thread };
  }

  async function renderThread(review, thread, onCount) {
    thread.replaceChildren(loading('Loading replies…'));
    let items = [];
    try {
      const data = await api.reviews.comments(review.id);
      if (data.enabled === false) {
        thread.replaceChildren(h('p', { class: 'lm-muted lm-small' }, 'Replies are turned off on this server.'));
        return;
      }
      items = data.items;
    } catch (err) {
      thread.replaceChildren(errorState(err));
      return;
    }
    const listEl = h('ol', { class: 'lm-replies' });
    const listSlot = h('div', { class: 'lm-replies__slot' });
    const paint = () => {
      listEl.replaceChildren(...items.map((c) => replyItem(c)));
      listSlot.replaceChildren(items.length ? listEl : h('p', { class: 'lm-muted lm-small lm-replies__empty' }, 'No replies yet.'));
      onCount(items.filter((c) => c.status === 'visible').length);
    };
    const replyItem = (c) => {
      const del = c.isMine ? h('button', { type: 'button', class: 'lm-link lm-reply__action', onClick: async () => {
        const ok = await confirmDialog({ title: 'Delete your reply?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
          await api.reviews.removeComment(c.id);
          items = items.filter((x) => x.id !== c.id);
          paint();
          announce('Reply deleted');
          // The deleted reply's button is gone; keep keyboard focus inside the thread.
          (thread.querySelector('textarea') || thread.closest('article') || thread.parentElement?.querySelector('[aria-controls]'))?.focus();
        } catch (err) {
          toastError(err);
        }
      } }, 'Delete') : null;
      const report = !c.isMine && canInteract() ? h('button', { type: 'button', class: 'lm-link lm-reply__action', onClick: () => openReport('comment', c.id, `${c.author.name}’s reply`) }, 'Report') : null;
      return h('li', { class: 'lm-reply' },
        avatar(c.author.avatar, { className: 'lm-avatar lm-reply__avatar' }),
        h('div', { class: 'lm-reply__body' },
          h('div', { class: 'lm-reply__meta' },
            h('strong', null, c.author.name),
            h('time', { datetime: c.createdAt, title: date(c.createdAt) }, relativeTime(c.createdAt)),
            c.status === 'pending' ? h('span', { class: 'lm-badge lm-badge--warn', title: 'Only you can see this until a moderator has looked at it.' }, 'Pending review') : null),
          h('p', null, c.body),
          del || report ? h('div', { class: 'lm-reply__actions' }, del, report) : null));
    };
    paint();

    let form = null;
    if (!session.isSignedIn) {
      form = h('p', { class: 'lm-small lm-muted' }, h('a', { class: 'lm-link', href: signInHref(title.id) }, 'Sign in'), ' to reply.');
    } else if (session.profile && !session.profile.isKids && review.status === 'visible') {
      const field = countedTextarea({ label: review.isMine ? 'Reply in this thread' : `Reply to ${review.author.name}`, name: 'body', max: REPLY_MAX, rows: 3, placeholder: 'Add to the conversation…' });
      const send = button('Reply', { variant: 'primary', size: 'sm', type: 'submit', icon: 'send' });
      form = h('form', { class: 'lm-reply-form', novalidate: true }, field, h('div', { class: 'lm-cluster' }, send));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = field.control.value.trim();
        if (!text) {
          field.setError('Write a reply first.');
          field.control.focus();
          return;
        }
        field.setError('');
        withBusy(send, async () => {
          try {
            const { comment } = await api.reviews.comment(review.id, text);
            items.push(comment);
            paint();
            field.control.value = '';
            field.control.dispatchEvent(new Event('input'));
            if (comment.status === 'pending') toast('Your reply is waiting for a moderator before others can see it.', { timeout: 6000 });
            else announce('Reply posted');
          } catch (err) {
            if (err.fields?.body) field.setError(err.fields.body);
            else toastError(err);
          }
        });
      });
    }
    thread.replaceChildren(...[listSlot, form].filter(Boolean));
  }

  // ── Report & block ──
  function openReport(targetType, targetId, what) {
    const name = newUid('reason');
    const detailsField = countedTextarea({ label: 'Anything else moderators should know? (optional)', name: 'details', max: 1000, rows: 3 });
    const errorEl = h('p', { class: 'lm-error-text', role: 'alert', hidden: true });
    const choices = h('fieldset', { class: 'lm-options' },
      h('legend', { class: 'lm-label' }, 'Why are you reporting this?'),
      ...REPORT_REASONS.map((r) => h('label', { class: 'lm-option' },
        h('input', { type: 'radio', name, value: r.value }),
        h('span', { class: 'lm-option__text' }, h('strong', null, r.label), h('span', null, r.hint)))));
    let modal;
    const send = button('Send report', { variant: 'primary', icon: 'flag' });
    const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
    send.addEventListener('click', () => {
      const reason = choices.querySelector('input:checked')?.value;
      if (!reason) {
        errorEl.textContent = 'Choose a reason.';
        errorEl.hidden = false;
        choices.querySelector('input')?.focus();
        return;
      }
      withBusy(send, async () => {
        try {
          await api.reviews.report({ targetType, targetId, reason, details: detailsField.control.value.trim() || undefined });
          modal.close();
          toast('Thank you. A moderator will look at it; the author is not told who reported it.', { type: 'success', timeout: 6000 });
        } catch (err) {
          if (err.code === 'ALREADY_REPORTED') {
            modal.close();
            toast(err.message);
          } else {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
          }
        }
      });
    });
    modal = openModal({
      title: `Report ${what}`,
      sheet: true,
      content: h('div', { class: 'lm-stack' }, h('p', { class: 'lm-muted lm-small' }, 'Reports are private and reviewed by the Lumina moderation team.'), choices, detailsField, errorEl),
      actions: [cancel, send],
    });
  }

  async function blockAuthor(review, article) {
    const ok = await confirmDialog({
      title: `Block ${review.author.name}?`,
      message: 'You will no longer see their reviews or replies. They are not notified. You can unblock them any time from “Blocked members”.',
      confirmLabel: 'Block',
      danger: true,
    });
    if (!ok) return;
    try {
      const index = [...list.children].indexOf(article);
      await api.reviews.block(review.id);
      toast(`${review.author.name} is blocked.`, { type: 'success' });
      await load();
      // Their reviews are gone from the list: continue from the review that took this one's
      // place (or the "Blocked members" button, where the block can be undone).
      const reviews = [...list.querySelectorAll(':scope > article')];
      const next = reviews[Math.min(Math.max(index, 0), reviews.length - 1)];
      (next || toolbar.querySelector('button') || root.querySelector('h2'))?.focus();
    } catch (err) {
      toastError(err);
    }
  }

  async function openBlocks() {
    const body = h('div', { class: 'lm-blocks' }, loading('Loading…'));
    openModal({ title: 'Blocked members', content: body });
    const paint = (items) => {
      if (!items.length) {
        body.replaceChildren(h('p', { class: 'lm-muted' }, 'You have not blocked anyone. Blocking hides a member’s reviews and replies from you.'));
        return;
      }
      body.replaceChildren(h('ul', { class: 'lm-blocks__list' }, ...items.map((b) => {
        const unblock = button('Unblock', { variant: 'ghost', size: 'sm' });
        unblock.addEventListener('click', () => withBusy(unblock, async () => {
          try {
            await api.reviews.unblock(b.id);
            items = items.filter((x) => x.id !== b.id);
            paint(items);
            announce(`${b.name} unblocked`);
            load();
          } catch (err) {
            toastError(err);
          }
        }));
        return h('li', null, h('div', null, h('strong', null, b.name), h('span', { class: 'lm-small lm-muted' }, `Blocked ${relativeTime(b.createdAt)}`)), unblock);
      })));
    };
    try {
      paint((await api.reviews.blocks()).items);
    } catch (err) {
      body.replaceChildren(errorState(err));
    }
  }

  load();
  return root;
}
