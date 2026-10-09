// Creators — how independent filmmakers bring work to Lumina. Works in Preview mode as an
// information page; applying and the creator dashboard need the Lumina server.
import { h, newUid } from '../core/dom.js';
import { api, ServerRequiredError } from '../api/client.js';
import { session, refreshSession } from '../core/session.js';
import { bytes, date, relativeTime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import {
  button, linkButton, withBusy, toast, notice, field, applyFieldErrors, formValues, sectionHead, loading, errorState,
} from '../ui/components.js';
import { uploadRequirements } from '../ui/uploader.js';

const STEPS = [
  { jp: '一', title: 'Apply', text: 'Tell us who you are and share some of your past work. One short application per account.' },
  { jp: '二', title: 'Get verified', text: 'A member of the Lumina team reviews every application by hand and confirms your identity as a creator.' },
  { jp: '三', title: 'Submit your work', text: 'Create a submission, describe the project and upload your master files. Uploads resume if your connection drops.' },
  { jp: '四', title: 'Rights & documentation', text: 'Confirm who owns the work, where it may be shown, and that music and third-party footage are cleared.' },
  { jp: '五', title: 'Human review', text: 'Reviewers check the files, the rights and the content. If something is missing, they ask — you answer in the same place.' },
  { jp: '六', title: 'Publication', text: 'Only after approval does a Lumina editor publish the title. Nothing is ever published automatically.' },
];

const CONTENT = [
  { icon: 'film', title: 'Feature films', text: 'Narrative features of any genre.' },
  { icon: 'clapper', title: 'Short films', text: 'Shorts, festival cuts and anthologies.' },
  { icon: 'globe', title: 'Documentaries', text: 'Feature and short documentary work.' },
  { icon: 'tv', title: 'TV pilots', text: 'A single pilot episode for a proposed series.' },
  { icon: 'layers', title: 'Complete series', text: 'Every season and episode of a finished series.' },
  { icon: 'list', title: 'Individual episodes', text: 'New episodes for a series already on Lumina.' },
  { icon: 'play', title: 'Trailers & promotion', text: 'Trailers, teasers and promotional clips.' },
];

const FAQ = [
  ['Who reviews my submission?', 'People. Every application and every submission is reviewed by a member of the Lumina team. Automated checks (file type, integrity, and a malware scan where the server has one configured) only help them — they never approve or publish anything.'],
  ['Who can see my files?', 'Only you and Lumina staff reviewing your submission. Uploaded files are stored privately on the Lumina server, outside the public website, and reviewers open them through short-lived signed links.'],
  ['What if my upload is interrupted?', 'Uploads are sent in parts. If your connection drops, Lumina retries automatically; if you close the page, choose the same file again from the same device and it continues from where it stopped.'],
  ['Can I change a submission after sending it?', 'A sent submission is locked while it is reviewed. If a reviewer needs something, the submission moves to “Information needed”, you can edit details and files again, and you reply in the submission’s timeline.'],
  ['Which subtitle format should I use?', 'WebVTT (.vtt) is preferred; SubRip (.srt) is accepted. Files must be UTF-8 text. Please upload one file per language and name the language in the file name.'],
  ['What happens after approval?', 'An editor prepares the title page and publishes it. You will see it on your creator dashboard with honest statistics: how many profiles watched it, its member rating and how many written reviews it has.'],
  ['What are the terms?', 'The creator agreement describes the licence you grant Lumina and your responsibilities. Please read it before you confirm your rights — it is linked from the rights step of every submission.'],
];

function stepsSection() {
  return h('section', { class: 'lm-creators__section', 'aria-labelledby': 'cr-steps' },
    sectionHead('How it works', { id: 'cr-steps', subtitle: 'Six steps from first contact to the Lumina catalog' }),
    h('ol', { class: 'lm-steps' }, ...STEPS.map((s, i) => h('li', { class: 'lm-steps__item' },
      h('span', { class: 'lm-steps__num lm-jp', 'aria-hidden': 'true' }, s.jp),
      h('div', null,
        h('span', { class: 'lm-steps__index' }, `Step ${i + 1}`),
        h('h3', { class: 'lm-steps__title' }, s.title),
        h('p', null, s.text))))));
}

function contentSection() {
  return h('section', { class: 'lm-creators__section', 'aria-labelledby': 'cr-content' },
    sectionHead('What you can submit', { id: 'cr-content' }),
    h('ul', { class: 'lm-kinds' }, ...CONTENT.map((c) => h('li', { class: 'lm-kinds__item' },
      h('span', { class: 'lm-kinds__icon', 'aria-hidden': 'true' }, icon(c.icon)),
      h('div', null, h('strong', null, c.title), h('span', null, c.text))))));
}

function requirementsSection(req) {
  const u = req?.uploads;
  const size = (n, fallback) => (n ? bytes(n) : fallback);
  const limitsNote = u
    ? 'These limits come from this Lumina server’s configuration.'
    : 'Default limits shown; the Lumina server you submit to may be configured differently.';
  const spec = (title, rows) => h('div', { class: 'lm-spec lm-panel' },
    h('h3', { class: 'lm-spec__title' }, title),
    h('dl', null, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  return h('section', { class: 'lm-creators__section', 'aria-labelledby': 'cr-tech' },
    sectionHead('Technical requirements', { id: 'cr-tech', subtitle: limitsNote }),
    h('div', { class: 'lm-specs' },
      spec('Video masters', [
        ['Containers', 'MP4, MOV, MKV, WebM or MPEG-TS'],
        ['Codecs', 'H.264, HEVC, ProRes, AV1 or VP9 video; AAC, PCM, AC-3 or E-AC-3 audio'],
        ['Resolution', 'Up to 4K UHD (2160p). Deliver at your native resolution — Lumina never upscales.'],
        ['Maximum size', `${size(u?.maxVideoBytes, '50 GB')} per file`],
      ]),
      spec('Artwork & documents', [
        ['Posters', `2:3 portrait, PNG, JPEG or WebP, up to ${size(u?.maxImageBytes, '15 MB')}`],
        ['Backdrops', `16:9 landscape, same formats and limit`],
        ['Documents', `PDF, up to ${size(u?.maxDocumentBytes, '25 MB')} (licences, releases, chain of title)`],
      ]),
      spec('Subtitles & captions', [
        ['Format', 'WebVTT (.vtt) preferred, SubRip (.srt) accepted'],
        ['Encoding', 'UTF-8 text'],
        ['Maximum size', `${size(u?.maxSubtitleBytes, '5 MB')} per file`],
        ['Languages', 'One file per language; only languages you actually provide are listed'],
      ]),
      spec('Delivery', [
        ['Uploads', `Resumable, sent in ${size(u?.chunkBytes, '8 MB')} parts`],
        ['Unfinished uploads', `Kept for ${u?.expireHours ?? 72} hours of inactivity`],
        ['Checks', 'File type by content, integrity (SHA-256), media probe, malware scan when configured'],
        ['Streaming', req?.transcoding?.available ? 'Approved masters are transcoded into an adaptive HLS ladder on this server.' : 'Approved masters are prepared for adaptive streaming by the Lumina team.'],
      ])));
}

function rightsSection() {
  const items = [
    ['You own or control the rights', 'You are the copyright owner, or hold a licence that lets you grant Lumina the rights in the creator agreement.'],
    ['Music is cleared', 'Every piece of music — score, songs and library tracks — is licensed for streaming distribution, or you tell us it is not.'],
    ['Footage and likenesses are cleared', 'Archive footage, artwork, locations and the people on screen are covered by releases or licences.'],
    ['You name the territories', 'Tell us where the work may be shown (worldwide or specific countries) and any restrictions or holdbacks.'],
    ['You can document it', 'Reviewers may ask for contracts, releases or chain-of-title documents. You can upload them as PDFs.'],
  ];
  return h('section', { class: 'lm-creators__section', 'aria-labelledby': 'cr-rights' },
    sectionHead('Rights requirements', { id: 'cr-rights', subtitle: 'Lumina only streams work that is authorised for streaming' }),
    h('ul', { class: 'lm-checklist' }, ...items.map(([t, d]) => h('li', null,
      h('span', { class: 'lm-checklist__mark', 'aria-hidden': 'true' }, icon('check')),
      h('div', null, h('strong', null, t), h('p', null, d))))),
    h('p', { class: 'lm-small lm-muted' }, 'You confirm these points for each submission. Read the ', h('a', { class: 'lm-link', href: '#/legal/creator-agreement' }, 'creator agreement'), ' first.'));
}

function faqSection() {
  return h('section', { class: 'lm-creators__section', 'aria-labelledby': 'cr-faq' },
    sectionHead('Questions', { id: 'cr-faq' }),
    h('div', { class: 'lm-faq' }, ...FAQ.map(([q, a]) => h('details', { class: 'lm-faq__item' },
      h('summary', null, h('span', null, q), icon('chevronDown')),
      h('p', null, a)))));
}

const APP_STATUS = {
  pending: { label: 'Waiting for review', badge: 'lm-badge--warn', text: 'Thank you for applying. A member of the Lumina team will review your application and you will get a notification when there is a decision.' },
  info_required: { label: 'More information needed', badge: 'lm-badge--warn', text: 'The reviewer asked for more information. Update your application below and send it again.' },
  approved: { label: 'Approved', badge: 'lm-badge--ok', text: 'You are a verified Lumina creator.' },
  rejected: { label: 'Not approved', badge: 'lm-badge--danger', text: 'Your previous application was not approved. You are welcome to apply again with more information.' },
};

function applicationForm(existing, onDone) {
  const fields = {
    legalName: field({ label: 'Legal name', name: 'legalName', required: true, autocomplete: 'name', value: existing?.legalName, maxlength: 200 }),
    contactEmail: field({ label: 'Contact email', name: 'contactEmail', type: 'email', required: true, autocomplete: 'email', value: existing?.contactEmail ?? session.account?.email, maxlength: 254 }),
    company: field({ label: 'Company or collective', name: 'company', value: existing?.company, maxlength: 200, hint: 'Optional' }),
    country: field({ label: 'Country', name: 'country', value: existing?.country, maxlength: 2, placeholder: 'JP', hint: 'Two-letter code, optional', autocomplete: 'country' }),
    website: field({ label: 'Website', name: 'website', type: 'url', value: existing?.website, placeholder: 'https://', hint: 'Optional' }),
    portfolio: field({ label: 'Portfolio or showreel', name: 'portfolio', type: 'url', value: existing?.portfolio, placeholder: 'https://', hint: 'A link reviewers can watch. Optional but helpful.' }),
    bio: field({ label: 'About you and your work', name: 'bio', type: 'textarea', required: true, rows: 6, value: existing?.bio, maxlength: 5000, hint: 'At least 40 characters: what you make, past screenings or releases, and what you would like to bring to Lumina.' }),
  };
  const submit = button(existing ? 'Send updated application' : 'Send application', { variant: 'primary', type: 'submit', icon: 'send' });
  const form = h('form', { class: 'lm-form', novalidate: true },
    h('div', { class: 'lm-form-row' }, fields.legalName, fields.contactEmail),
    h('div', { class: 'lm-form-row' }, fields.company, fields.country),
    h('div', { class: 'lm-form-row' }, fields.website, fields.portfolio),
    fields.bio,
    h('p', { class: 'lm-small lm-muted' }, 'We use these details only to review your application and contact you about it.'),
    h('div', { class: 'lm-cluster' }, submit));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    applyFieldErrors(form, null);
    const values = formValues(form);
    for (const k of Object.keys(values)) if (typeof values[k] === 'string') values[k] = values[k].trim();
    withBusy(submit, async () => {
      try {
        await api.creators.apply(values);
        toast('Application sent. We will notify you when it has been reviewed.', { type: 'success', timeout: 6000 });
        onDone();
      } catch (err) {
        if (!applyFieldErrors(form, err)) toast(err.message, { type: 'error' });
      }
    });
  });
  return form;
}

async function ctaSection() {
  const body = h('div', { class: 'lm-creators__cta-body' });
  const eyebrow = h('span', { class: 'lm-eyebrow' }, 'Become a Lumina creator');
  const heading = h('h2', { class: 'lm-h2', id: 'cr-apply' }, 'Apply to submit your work');
  const section = h('section', { class: 'lm-creators__section lm-creators__cta lm-panel', id: 'apply', 'aria-labelledby': 'cr-apply' },
    h('div', { class: 'lm-creators__cta-head' }, eyebrow, heading),
    body);

  const render = async () => {
    if (!session.isServer) {
      body.replaceChildren(notice('Applications are handled by the Lumina server. This copy of Lumina is running in Preview mode on static hosting, so you can read about the process here but not apply.', { title: 'Preview mode' }));
      return;
    }
    if (!session.isSignedIn) {
      body.replaceChildren(
        h('p', { class: 'lm-muted' }, 'You need a Lumina account to apply. It takes a minute, and the same account is used for your creator dashboard.'),
        h('div', { class: 'lm-cluster' },
          linkButton('Create an account', `#/register?next=${encodeURIComponent('/creators')}`, { variant: 'primary', icon: 'user' }),
          linkButton('Sign in', `#/login?next=${encodeURIComponent('/creators')}`, { variant: 'ghost', icon: 'login' })));
      return;
    }
    body.replaceChildren(loading('Checking your application…'));
    let me;
    try {
      me = await api.creators.me();
    } catch (err) {
      body.replaceChildren(errorState(err, { retry: render }));
      return;
    }
    if (me.isCreator) {
      eyebrow.textContent = 'Lumina creator';
      heading.textContent = 'Your creator studio';
      body.replaceChildren(
        h('div', { class: 'lm-creators__status' }, icon('checkCircle', { size: 28 }), h('div', null, h('strong', null, 'You are a verified creator.'), h('p', { class: 'lm-muted' }, 'Create submissions, upload files and follow their review from your dashboard.'))),
        h('div', { class: 'lm-cluster' }, linkButton('Open creator dashboard', '#/creators/dashboard', { variant: 'primary', icon: 'arrowRight' })));
      return;
    }
    const app = me.application;
    const onDone = async () => {
      await refreshSession().catch(() => {});
      render();
    };
    if (!app) {
      body.replaceChildren(applicationForm(null, onDone));
      return;
    }
    const meta = APP_STATUS[app.status] || APP_STATUS.pending;
    const status = h('div', { class: 'lm-creators__status' },
      icon(app.status === 'approved' ? 'checkCircle' : app.status === 'rejected' ? 'alert' : 'clock', { size: 28 }),
      h('div', null,
        h('div', { class: 'lm-cluster lm-cluster--sm' }, h('strong', null, 'Your application'), h('span', { class: `lm-badge ${meta.badge}` }, meta.label)),
        h('p', { class: 'lm-muted' }, meta.text),
        h('p', { class: 'lm-xsmall lm-muted' }, `Sent ${relativeTime(app.createdAt)} · last updated ${date(app.updatedAt)}`)));
    const parts = [status];
    if (app.reviewerNote) parts.push(notice(app.reviewerNote, { type: app.status === 'rejected' ? 'danger' : 'warn', title: 'Note from the reviewer' }));
    if (app.status === 'info_required') parts.push(applicationForm(app, onDone));
    if (app.status === 'rejected') parts.push(h('h3', { class: 'lm-h3' }, 'Apply again'), applicationForm(app, onDone));
    if (app.status === 'approved') parts.push(h('div', { class: 'lm-cluster' }, linkButton('Open creator dashboard', '#/creators/dashboard', { variant: 'primary', icon: 'arrowRight' })));
    body.replaceChildren(...parts);
  };
  await render();
  return section;
}

export default async function render(ctx) {
  ctx.setTitle('Creators');
  const isCreator = !!session.account?.isCreator;
  const heroId = newUid('cr');
  const hero = h('header', { class: 'lm-creators__hero', 'aria-labelledby': heroId },
    h('span', { class: 'lm-eyebrow' }, 'Lumina for creators'),
    h('h1', { class: 'lm-display lm-creators__title', id: heroId }, 'Bring your work to the garden'),
    h('p', { class: 'lm-creators__lede' }, 'Lumina is a home for independent film and television. Submit your films, series and documentaries, keep your rights, and follow every step of a review done by people — not algorithms.'),
    h('div', { class: 'lm-cluster' },
      isCreator
        ? linkButton('Open creator dashboard', '#/creators/dashboard', { variant: 'primary', size: 'lg', icon: 'arrowRight' })
        : h('a', { class: 'lm-btn lm-btn--primary lm-btn--lg', href: '#/creators', onClick: (e) => {
          e.preventDefault();
          document.getElementById('apply')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          document.getElementById('cr-apply')?.setAttribute('tabindex', '-1');
          document.getElementById('cr-apply')?.focus({ preventScroll: true });
        } }, icon('send'), h('span', null, 'Apply to become a creator')),
      linkButton('Creator agreement', '#/legal/creator-agreement', { variant: 'ghost', icon: 'shield' })),
    h('div', { class: 'lm-creators__roof', 'aria-hidden': 'true' }));

  let req = null;
  try {
    req = await uploadRequirements();
  } catch (err) {
    if (!(err instanceof ServerRequiredError)) req = null;
  }

  return h('div', { class: 'lm-page lm-container lm-creators' },
    hero,
    stepsSection(),
    contentSection(),
    requirementsSection(req),
    rightsSection(),
    faqSection(),
    await ctaSection());
}
