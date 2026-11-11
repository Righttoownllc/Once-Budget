// Tips the bank hasn't posted yet. A card first shows the pre-tip amount; the restaurant's final
// charge (with the tip) can take a week. The app records the full amount straight away and keeps
// tip_pending = the cents of tip the bank hasn't caught up with, until you confirm it posted.
import { put } from './store.js';
import { today, addDays } from './budget.js';

export const TIP_REMIND_DAYS = 10;
export const TIP_PCTS = [15, 18, 20];

/** Cents of tip on this transaction still waiting for the bank (0 if none, or already cleared). */
export const tipWaiting = t => (t && !t.deleted && t.cleared === 0 && t.tip_pending > 0 ? t.tip_pending : 0);

/** What the bank shows for this transaction until the tip posts (negative, like amount). */
export const bankAmount = t => t.amount + tipWaiting(t);

/** Tips still waiting after TIP_REMIND_DAYS days (oldest first), for Money check. */
export const staleTips = data => {
  const cutoff = addDays(today(), -TIP_REMIND_DAYS);
  return data.txs.filter(t => tipWaiting(t) && t.date <= cutoff).sort((a, b) => a.date.localeCompare(b.date));
};

/** The bank posted the full amount (with tip): cleared, nothing waiting. */
export const tipPosted = t => put('transactions', { ...t, cleared: 1, tip_pending: 0 });

/**
 * The bank posted a different amount (cents, positive): the transaction becomes that amount, cleared.
 * Its category follows automatically, because the budget is worked out from the transactions.
 */
export const tipPostedAs = (t, cents) => put('transactions', { ...t, amount: t.amount < 0 ? -Math.abs(cents) : Math.abs(cents), cleared: 1, tip_pending: 0 });
