// Monetization boundary. Every playback request asks this module whether the viewer may
// watch a title. Today Lumina runs in "free" mode: everything published is available to
// every signed-in or preview viewer, and no payment is collected anywhere.
//
// To introduce subscriptions, rentals or ad-supported tiers later, implement the checks
// here (backed by a payment provider's webhooks writing to an entitlements table) and keep
// the call sites unchanged. See docs/MONETIZATION.md.
import { config } from '../config.js';

export function canPlay({ account, title }) {
  switch (config.monetization.mode) {
    case 'free':
      return { allowed: true };
    default:
      // Unknown modes fail closed so a misconfiguration never gives away paid content.
      return { allowed: false, reason: 'ENTITLEMENT_REQUIRED', message: 'This title is not included in your plan.' };
  }
}

export function planSummary(account) {
  return { mode: config.monetization.mode, plan: 'Lumina Free', billing: null, cancellable: false };
}
