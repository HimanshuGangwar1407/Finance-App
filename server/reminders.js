// Which EMI reminders are due today — a pure function, so the rules are easy to read and test.
// Each reminder has a key; storing it with a unique constraint makes it happen once per instalment, however often
// reminders are checked.
//
//   upcoming  — from remind_days before the due date (0 = no advance reminder)
//   due       — on the due date
//   overdue   — once, the day after the due date or later, while still unpaid
//   shortfall — once, when the account's balance can't cover what is held for its EMIs (free < 0) while this
//               instalment is held or within its reminder window
import { addDays, inr } from './money.js';

const nice = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * instalments: unpaid EMI instalments [{payment_id, emi_id, lender, bank_id, bank_name, due_date, left, remind_days, hold_days}]
 * free: Map bank_id → balance − money held for EMIs (paise) · today: 'YYYY-MM-DD'
 * → [{key, kind, payment_id, emi_id, title, body}]
 */
export function dueReminders({ instalments, free, today }) {
  const out = [];
  for (const i of instalments) {
    if (!(i.left > 0)) continue;
    const what = `${i.lender} EMI of ${inr(i.left)} from ${i.bank_name}`;
    let kind = null, title = '';
    if (i.due_date < today) { kind = 'overdue'; title = `Overdue: ${what} was due on ${nice(i.due_date)}`; }
    else if (i.due_date === today) { kind = 'due'; title = `Due today: ${what}`; }
    else if (i.remind_days > 0 && addDays(i.due_date, -i.remind_days) <= today) { kind = 'upcoming'; title = `Upcoming: ${what} is due on ${nice(i.due_date)}`; }
    if (kind) out.push({ key: `emi:${i.payment_id}:${kind}`, kind, payment_id: i.payment_id, emi_id: i.emi_id, title, body: 'Confirm the payment under EMI management once it has gone through.' });
    const watchFrom = addDays(i.due_date, -Math.max(i.remind_days, i.hold_days));
    const short = free.get(i.bank_id);
    if (short != null && short < 0 && watchFrom <= today) {
      out.push({
        key: `emi:${i.payment_id}:shortfall`, kind: 'shortfall', payment_id: i.payment_id, emi_id: i.emi_id,
        title: `Not enough in ${i.bank_name} for EMIs: short by ${inr(-short)}`,
        body: `${i.lender} EMI of ${inr(i.left)} is due on ${nice(i.due_date)}. Move money into ${i.bank_name} before then.`,
      });
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
