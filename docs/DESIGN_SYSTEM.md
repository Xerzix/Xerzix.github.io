# Lumina design system

Lumina is black and velvet red. The layered Japanese garden stays mostly in the background. Velvet red marks **actions and states**: primary buttons, the active navigation item, selected chips and progress. Champagne gold is for **ornament and focus**: eyebrow text, rules, 4K badges and the focus ring. Neither colour is used for large fills.

## Tokens (`css/tokens.css`)
| Token | Default | Use |
|---|---|---|
| `--lm-bg` / `--lm-bg-2` | #080808 / #141414 | page / raised backgrounds |
| `--lm-surface`, `--lm-surface-2/3` | #121011 + tints | cards, panels, inputs |
| `--lm-accent` | #781B32 velvet | fills: primary buttons, selected chips |
| `--lm-accent-strong` | #B52B49 crimson | highlights, active indicators, progress |
| `--lm-accent-text` | computed | accent colour that stays AA-readable as text |
| `--lm-button` / `--lm-button-text` | velvet / computed | primary button |
| `--lm-text` / `--lm-text-2` / `--lm-text-3` | #F8F5F2 / #B8B3B4 / derived | body / secondary / tertiary (tertiary is for non-essential text only) |
| `--lm-gold` | #C6A46A | ornament, focus ring, 4K badge |
| `--lm-line`, `--lm-line-strong` | text at 9% / 18% | hairlines |
| `--lm-font-display` | Cormorant Garamond | titles, headings, logo |
| `--lm-font-ui` | Inter | everything else |
| `--lm-font-jp` | Shippori Mincho | Japanese glyphs |
| `--lm-space-1…16` | 4 px scale × `--lm-density` | spacing (density: compact 0.82, spacious 1.18) |
| `--lm-radius-xs…xl`, `--lm-radius-pill` | 4–24 px | radii |
| `--lm-shadow-1…3`, `--lm-shadow-glow` | | elevation |
| `--lm-dur-1…5`, `--lm-ease*` | 120–900 ms | motion (drop to 1 ms under reduced motion) |

Themes (`js/theme.js`) override the palette at runtime and compute `--lm-accent-text` and `--lm-button-text` so contrast holds. Environments (`data-environment` on `<html>`) re-tint the garden through the `--env-*` variables.

## Components
- **Buttons**
  - `.lm-btn` with a variant: `--primary` (velvet), `--light` (white, for "Play" on imagery), `--glass`, `--ghost` or `--danger`.
  - Size: `--sm` or `--lg`. Shape: `--icon` or `--block`. Busy state: `.is-busy`.
  - JS helpers: `button(label, opts)`, `linkButton(label, href, opts)`, `withBusy(btn, fn)`.
- **Chips & badges:** `.lm-chip` (use `aria-pressed` for filters), `.lm-badge` (`--4k`, `--accent`, `--solid`, `--warn`, `--ok`, `--danger`), and `.lm-meta` for a metadata line (`titleMeta(t)`).
- **Forms**
  - Classes: `.lm-form`, `.lm-form-row`, `.lm-field` (label, control, hint, error), `.lm-input`, `.lm-select`, `.lm-textarea`, `.lm-checkbox`, `.lm-switch` (`role=switch`), `.lm-segmented`, `.lm-range`.
  - JS helpers: `field()`, `applyFieldErrors(form, err)`, `formValues(form)`, `toggleSwitch()`, `segmented()`, `settingRow()`.
- **Layout:** `.lm-page` (clears the header), `.lm-container`, `.lm-page-header`, `.lm-stack`, `.lm-cluster`, `.lm-grid` (poster grid) or `.lm-grid--landscape`, `.lm-two-col`, and `.lm-panel` (translucent surface), plus the `sectionHead()` helper.
- **Navigation:** `.lm-tabs` / `tabs()` for in-page tabs with roving focus; `bindMenu(trigger, menu)` for `.lm-menu` popovers.
- **Feedback**
  - Toasts: `toast(msg, {type})`, `toastError(err)`.
  - Dialogs: `openModal({title, content, actions, sheet})`, `confirmDialog()`.
  - States: `notice(msg, {type})`, `loading()`, `emptyState()`, `errorState()`, `serverRequired(feature)`.
- **Catalog**
  - `titleCard(t, {variant:'poster'|'landscape', progress, episode})`: the hover/focus overlay has details and quick actions; the touch info button opens `quickView()`.
  - `carousel({id, title, items, variant})` for rows. `cardGrid(items)` for grids. `hero(items)` for the featured banner.
- **Ratings:** `stars(value)` displays a rating; `starInput({value, onChange})` is an accessible radio group.
- **Avatars:** `avatar(id)` draws from 12 built-in garden motifs (`AVATARS`).
- **Icons:** `icon(name)` from `js/ui/icons.js` (24 px line icons); `logoMark()`.

## Motion
- Durations come from tokens.
- Page transitions: `.lm-view` fades and rises by 10 px.
- Cards scale to 1.06 on hover or focus.
- The hero crossfades with a slow push-in.
- Under reduced motion everything important still works. The hero stops rotating, parallax stops, and the particles freeze into a few resting petals.
