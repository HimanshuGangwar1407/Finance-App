// Which EMI reminders are due today, and which instalments an account can't cover — pure functions, so the rules
// are easy to read and test. Each reminder has a key; storing it with a unique constraint makes it happen once per
// instalment, however often reminders are checked.
//
//   upcoming  — at each chosen number of days before the due date (7, 3 and 1 by default). If a day is missed
//               (nobody used the app), only the latest one that has passed is sent, never a burst of old ones.
//   due       — on the due date (can be switched off)
//   overdue   — once, after the due date, while still unpaid (can be switched off)
//   shortfall — once, when the account's balance can't cover this instalment together with its EMIs due before it
//               (see coverage), from 7 days before — or earlier if reminders or the reservation start earlier
import { inr } from './money.js';

const nice = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
export const DEFAULT_BEFORE = [7, 3, 1];

/**
 * Can each account cover its EMIs? Unpaid instalments are taken in due-date order per account; each one needs the
 * balance to cover it plus every earlier unpaid one from the same account (overdue ones included).
 * instalments: [{payment_id, bank_id, due_date, left}] · balances: Map bank_id → balance now (paise)
 * → Map payment_id → {needed, covered, shortBy}
 */
export function coverage(instalments, balances) {
  const out = new Map(), running = new Map();
  const open = instalments.filter((i) => i.left > 0).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.payment_id - b.payment_id);
  for (const i of open) {
    const needed = (running.get(i.bank_id) ?? 0) + i.left, balance = balances.get(i.bank_id) ?? 0;
    running.set(i.bank_id, needed);
    out.set(i.payment_id, { needed, covered: balance >= needed, shortBy: Math.max(0, needed - balance) });
  }
  return out;
}

/**
 * instalments: unpaid EMI instalments [{payment_id, emi_id, lender, bank_id, bank_name, due_date, left,
 *   remind_before: [days…], remind_due, remind_overdue, hold_days}]
 * balances: Map bank_id → balance now (paise) · today: 'YYYY-MM-DD'
 * → [{key, kind, payment_id, emi_id, title, body}]
 */
export function dueReminders({ instalments, balances, today }) {
  const out = [], cover = coverage(instalments, balances);
  for (const i of instalments) {
    if (!(i.left > 0)) continue;
    const what = `${i.lender} EMI of ${inr(i.left)} from ${i.bank_name}`, daysLeft = daysBetween(today, i.due_date);
    const body = 'Confirm the payment under EMI management once it has gone through.';
    const add = (kind, title, text = body, key = kind) => out.push({ key: `emi:${i.payment_id}:${key}`, kind, payment_id: i.payment_id, emi_id: i.emi_id, title, body: text });
    const before = i.remind_before ?? DEFAULT_BEFORE;
    if (daysLeft < 0) {
      if (i.remind_overdue !== false) add('overdue', `Overdue: ${what} was due on ${nice(i.due_date)}`);
    } else if (daysLeft === 0) {
      if (i.remind_due !== false) add('due', `Due today: ${what}`);
    } else {
      const k = before.filter((d) => d >= daysLeft).sort((a, b) => a - b)[0]; // the latest reminder point reached
      if (k) add('upcoming', `In ${daysLeft} day${daysLeft === 1 ? '' : 's'}: ${what} is due on ${nice(i.due_date)}`, body, `before${k}`);
    }
    const c = cover.get(i.payment_id), watch = Math.max(7, ...before, i.hold_days ?? 0);
    if (c && !c.covered && daysLeft <= watch) {
      add('shortfall', `Not enough in ${i.bank_name}: short by ${inr(c.shortBy)} for the ${i.lender} EMI on ${nice(i.due_date)}`,
        `${i.bank_name} needs ${inr(c.needed)} for its EMIs up to then. Move money into it before the due date.`);
    }
  }
  return out;
}

// the next `months` monthly dates of an EMI from `from` (inclusive), within its last date if it has one
export function projectDates(emi, from, months = 12) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let k = 0; k < months + 1 && out.length < months; k++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(emi.day, last)).padStart(2, '0')}`;
    if (d >= from && d >= emi.start_date && (!emi.end_date || d <= emi.end_date)) out.push(d);
    if (emi.end_date && d > emi.end_date) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
