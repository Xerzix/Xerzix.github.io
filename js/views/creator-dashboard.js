// Creator dashboard (/creators/dashboard): submissions with their status, a form to start a
// new one, and published titles with honest statistics.
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { date, plural, relativeTime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import {
  button, linkButton, withBusy, openModal, field, applyFieldErrors, formValues, emptyState, errorState, sectionHead, notice, stars,
} from '../ui/components.js';

/** Every submission status, as creators see it. */
export const STATUS_META = {
  draft: { label: 'Draft', badge: 'lm-badge--solid', icon: 'edit', text: 'Only you can see this. Finish the steps and submit it for review.' },
  uploading: { label: 'Uploading', badge: 'lm-badge--accent', icon: 'upload', text: 'Files are still uploading.' },
  submitted: { label: 'Submitted', badge: 'lm-badge--4k', icon: 'send', text: 'Waiting for a person on the Lumina team to review it.' },
  under_review: { label: 'In review', badge: 'lm-badge--4k', icon: 'eye', text: 'A reviewer is looking at your files and rights.' },
  info_required: { label: 'Information needed', badge: 'lm-badge--warn', icon: 'alert', text: 'The reviewer asked for something. Open the submission to reply.' },
  approved: { label: 'Approved', badge: 'lm-badge--ok', icon: 'checkCircle', text: 'Approved. An editor will prepare the title for publication.' },
  rejected: { label: 'Not accepted', badge: 'lm-badge--danger', icon: 'close', text: 'This submission was not accepted.' },
  published: { label: 'Published', badge: 'lm-badge--ok', icon: 'sparkle', text: 'Live on Lumina.' },
};

export const CONTENT_TYPES = [
  { value: 'movie', label: 'Feature film' },
  { value: 'short', label: 'Short film' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'pilot', label: 'TV pilot' },
  { value: 'series', label: 'Complete series' },
  { value: 'episode', label: 'Individual episode' },
  { value: 'trailer', label: 'Trailer or promotional material' },
];
export const contentTypeLabel = (v) => CONTENT_TYPES.find((c) => c.value === v)?.label || v;

export function statusBadge(status) {
  const m = STATUS_META[status] || { label: status, badge: 'lm-badge--solid' };
  return h('span', { class: `lm-badge lm-status ${m.badge}`, 'data-status': status }, m.label);
}

/** Modal form that creates a draft and opens it. */
export function newSubmissionDialog(navigate) {
  const title = field({ label: 'Project title', name: 'projectTitle', required: true, maxlength: 200 });
  const type = field({ label: 'What are you submitting?', name: 'contentType', type: 'select', options: CONTENT_TYPES, value: 'movie' });
  const desc = field({ label: 'Short description', name: 'description', type: 'textarea', rows: 4, maxlength: 5000, hint: 'You can refine this later. At least 20 characters before you submit.' });
  const form = h('form', { class: 'lm-form', novalidate: true }, title, type, desc);
  let modal;
  const create = button('Create draft', { variant: 'primary', icon: 'plus' });
  const submit = () => withBusy(create, async () => {
    applyFieldErrors(form, null);
    const values = formValues(form);
    try {
      const { submission } = await api.creators.createSubmission({ projectTitle: values.projectTitle.trim(), contentType: values.contentType, description: values.description.trim() });
      modal.close();
      navigate(`/creators/submissions/${submission.id}`);
    } catch (err) {
      if (!applyFieldErrors(form, err)) form.prepend(notice(err.message, { type: 'danger' }));
    }
  });
  create.addEventListener('click', submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  modal = openModal({ title: 'New submission', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), create] });
  setTimeout(() => title.control.focus(), 30);
}

function submissionRow(s) {
  const m = STATUS_META[s.status] || {};
  return h('li', { class: 'lm-sub-row' },
    h('a', { class: 'lm-sub-row__link', href: `#/creators/submissions/${encodeURIComponent(s.id)}` },
      h('span', { class: 'lm-sub-row__icon', 'aria-hidden': 'true', 'data-status': s.status }, icon(m.icon || 'film')),
      h('span', { class: 'lm-sub-row__main' },
        h('strong', { class: 'lm-sub-row__title' }, s.projectTitle),
        h('span', { class: 'lm-sub-row__meta' }, `${contentTypeLabel(s.contentType)} · ${plural(s.fileCount || 0, 'file')} · updated ${relativeTime(s.updatedAt)}`),
        h('span', { class: 'lm-sub-row__hint' }, m.text || '')),
      statusBadge(s.status),
      icon('chevronRight', { className: 'lm-sub-row__chev' })));
}

function titleTile(t) {
  const r = t.stats.memberRating;
  const live = t.status === 'published';
  // Only a published title has a page members (and you) can open; before that, the title
  // links to the submission it came from.
  const href = live ? `#/title/${encodeURIComponent(t.id)}` : t.submissionId ? `#/creators/submissions/${encodeURIComponent(t.submissionId)}` : null;
  const art = t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy' }) : h('span', { class: 'lm-studio-title__placeholder' }, icon('film'));
  const statusText = live
    ? `Published ${t.publishedAt ? date(t.publishedAt) : ''}`
    : t.status === 'draft' ? 'Awaiting publication — not visible to members yet' : 'Not published — not visible to members';
  return h('li', { class: 'lm-studio-title' },
    href
      ? h('a', { class: 'lm-studio-title__art', href, tabindex: '-1', 'aria-hidden': 'true' }, art)
      : h('span', { class: 'lm-studio-title__art', 'aria-hidden': 'true' }, art),
    h('div', { class: 'lm-studio-title__body' },
      href
        ? h('a', { class: 'lm-studio-title__name', href, 'aria-label': live ? undefined : `${t.title} (view submission)` }, t.title)
        : h('strong', { class: 'lm-studio-title__name' }, t.title),
      h('span', { class: 'lm-xsmall lm-muted' }, statusText),
      h('dl', { class: 'lm-studio-stats' },
        h('div', null, h('dt', null, 'Profiles watched'), h('dd', null, t.stats.viewers.toLocaleString())),
        h('div', null, h('dt', null, 'Member rating'), h('dd', null, r ? h('span', { class: 'lm-cluster lm-cluster--sm' }, stars(r.average, { label: `${r.average} out of 5` }), `${r.average} (${r.count.toLocaleString()})`) : 'No ratings yet')),
        h('div', null, h('dt', null, 'Written reviews'), h('dd', null, t.stats.reviewCount.toLocaleString())))));
}

export default async function render(ctx) {
  ctx.setTitle('Creator dashboard');
  const header = (actions = []) => h('header', { class: 'lm-page-header lm-studio__header' },
    h('div', null,
      h('span', { class: 'lm-eyebrow' }, 'Creator studio'),
      h('h1', { class: 'lm-h1' }, 'Your submissions'),
      h('p', null, 'Every submission is reviewed by a person. You will be notified whenever its status changes.')),
    h('div', { class: 'lm-cluster' }, ...actions));

  let me;
  try {
    me = await api.creators.me();
  } catch (err) {
    return h('div', { class: 'lm-page lm-container' }, header(), errorState(err, { retry: () => ctx.navigate('/creators/dashboard', { replace: true }) }));
  }
  if (!me.isCreator) {
    const app = me.application;
    const message = app?.status === 'pending'
      ? 'Your creator application is waiting for review. You will be able to create submissions here once it is approved.'
      : app?.status === 'info_required'
        ? 'The reviewer asked for more information about your application.'
        : 'Apply to become a verified creator to submit your work to Lumina.';
    return h('div', { class: 'lm-page lm-container' }, header(), emptyState({
      title: app ? 'Your application is in progress' : 'Become a Lumina creator',
      message,
      actions: [linkButton(app ? 'View your application' : 'Apply now', '#/creators', { variant: 'primary', icon: 'arrowRight' })],
    }));
  }

  const newBtn = button('New submission', { variant: 'primary', icon: 'plus', onClick: () => newSubmissionDialog(ctx.navigate) });
  const page = h('div', { class: 'lm-page lm-container lm-studio' },
    header([linkButton('Notifications', '#/notifications', { variant: 'ghost', icon: 'bell' }), newBtn]));

  const [subs, titles] = await Promise.allSettled([api.creators.submissions(), api.creators.titles()]);

  // Submissions
  const subSection = h('section', { class: 'lm-studio__section', 'aria-labelledby': 'st-subs' });
  if (subs.status === 'rejected') {
    subSection.append(sectionHead('Submissions', { id: 'st-subs' }), errorState(subs.reason));
  } else {
    const items = subs.value.items;
    const count = (list) => items.filter((s) => list.includes(s.status)).length;
    const summary = [
      ['Drafts', count(['draft', 'uploading']), 'edit'],
      ['In review', count(['submitted', 'under_review']), 'eye'],
      ['Needs your reply', count(['info_required']), 'alert'],
      ['Approved & live', count(['approved', 'published']), 'sparkle'],
    ];
    subSection.append(
      h('ul', { class: 'lm-studio__summary', 'aria-label': 'Submission summary' }, ...summary.map(([label, n, ic]) => h('li', { class: n && label === 'Needs your reply' ? 'is-attention' : '' },
        icon(ic), h('strong', null, n.toLocaleString()), h('span', null, label)))),
      sectionHead('Submissions', { id: 'st-subs', subtitle: items.length ? 'Most recently updated first' : undefined }),
      items.length
        ? h('ul', { class: 'lm-sub-list' }, ...items.map(submissionRow))
        : emptyState({
          title: 'Nothing submitted yet',
          message: 'Start a draft, upload your files at your own pace and send it for review when everything is ready.',
          actions: [button('Start a submission', { variant: 'primary', icon: 'plus', onClick: () => newSubmissionDialog(ctx.navigate) })],
        }));
  }
  page.append(subSection);

  // Published titles
  const titleSection = h('section', { class: 'lm-studio__section', 'aria-labelledby': 'st-titles' },
    sectionHead('Your titles on Lumina', { id: 'st-titles', subtitle: 'Counts come from real viewing history and member reviews' }));
  if (titles.status === 'rejected') titleSection.append(errorState(titles.reason));
  else if (!titles.value.items.length) titleSection.append(h('p', { class: 'lm-muted' }, 'When a submission is published, its title appears here with viewing and rating statistics.'));
  else titleSection.append(h('ul', { class: 'lm-studio-titles' }, ...titles.value.items.map(titleTile)));
  page.append(titleSection);
  return page;
}
