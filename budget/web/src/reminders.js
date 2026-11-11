// Bill reminders in the Android app. The shell (Reminders.kt) checks once a day and posts
// "Bill due today"; this keeps its copy of the scheduled items and the user's settings current.
// Settings are per device (localStorage); the browser version uses the server's web push instead.
import { callNative } from './platform.js';

const KEY = 'budget.reminders';
export function reminderSettings() {
  try { return { enabled: false, hour: 8, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { enabled: false, hour: 8 }; }
}
let last = '';
export function syncReminders(data, settings = reminderSettings()) {
  const items = data.scheduled.filter(s => !s.auto && !s.deleted)
    .map(s => ({ payee: s.transfer_to ? 'Transfer' : s.payee || 'Scheduled item', amount: s.amount, next_date: s.next_date }));
  const payload = JSON.stringify({ ...settings, items });
  if (payload === last) return Promise.resolve();
  last = payload;
  return callNative('reminders.sync', JSON.parse(payload)).catch(() => { last = ''; });
}
export function saveReminderSettings(data, s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return syncReminders(data, s);
}
export const testReminder = () => callNative('reminders.test');
