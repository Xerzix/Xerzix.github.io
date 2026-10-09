# Monetization boundary

Lumina runs in **free mode**. No payment is collected anywhere and no advertising is shown. There are no trackers and no stored payment details. The account page describes this plan as "Lumina Free — no payment details are stored".

Monetization is designed so it can be added **without rewriting authentication or playback**:

1. **One decision point.** Every playback request calls `canPlay({ account, title })` in `server/services/entitlements.js` before it hands out a media URL. Unknown modes fail closed and return HTTP 402 `ENTITLEMENT_REQUIRED`. The player already shows a clear message for that response.
2. **Plans are account-level.** Profiles are not subscriptions and not concurrent streams. The profile-limit copy states this explicitly.
3. **Future models** each need their own backing data plus a payment provider's webhooks:

| Model | What `canPlay` would check | Needs |
|---|---|---|
| Ad-supported free tier | Always allowed; the player inserts ads | An ad server (VAST/VMAP, IMA SDK), consent management, a privacy-policy update |
| Monthly / annual subscription | An active `subscriptions` row for the account | Payment provider (e.g. Stripe Billing), webhooks → `subscriptions`, a billing page with cancel in one click, dunning |
| Premium tier (4K, more streams) | Plan features, e.g. cap delivered height below 2160 on basic plans | The same, plus `hls.autoLevelCapping` driven by the entitlement |
| Rentals / purchases | An `entitlements(account_id, title_id, expires_at)` row | Payments, and territory rights recorded per title (the creator submission rights model already captures territories) |
| Creator-supported | Per-creator tiers | Payouts (e.g. Stripe Connect), tax handling, revenue reporting in the creator dashboard |

Before any of this ships, the legal drafts in `content/legal/` (Terms, Privacy, Cookies) need review. Consumer-protection rules for cancellation and consent also apply.
