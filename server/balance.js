// The final balance per bank account — a pure function of the stored records.
//
//   balance today  = the latest balance entered for the account
//                    + money received into it after that date − money paid from it after that date
//                    (anything dated on or before the balance date is assumed to be inside that balance)
//   to receive     = the unreceived part of each open receipt (cancelled and disputed ones left out)
//   to pay         = the unpaid part of each open payment
//   final balance  = balance today + to receive − to pay
//   held for EMIs  = the unpaid part of each EMI whose hold has started by the date (from hold_days before it is due)
//   free           = balance today − held for EMIs: what can go to anyone else without touching EMI money
//
// Receipts and payments without an account are shown under "Account not decided" so nothing is left out.

/**
 * banks: [{id, name, bank, last4}] · balances: [{bank_id, amount, as_of}] (any order) ·
 * receipts: [{id, party, ref, amount, expected_date, certainty, bank_id, disputed?}] ·
 * payments: [{id, payee, ref, category, amount, due_date, bank_id, approved, emi_id?, hold_from?}] ·
 * entries: [{kind: 'IN'|'OUT', receipt_id, payment_id, bank_id, amount, date}]
 * options: upTo (YYYY-MM-DD or null = everything), approvedOnly, uncertain (include uncertain receipts)
 */
export function finalBalance({ banks, balances, receipts, payments, entries, today, upTo = null, approvedOnly = false, uncertain = true }) {
  const within = (d) => !upTo || d <= upTo;
  const blank = (b) => ({ id: b?.id ?? null, name: b ? b.name : 'Account not decided', bank: b ? `${b.bank} XXXX${b.last4}` : '', balance: null, asOf: null, since: 0, today: 0, receive: 0, pay: 0, final: 0, held: 0, free: 0, holds: [], items: [] });
  const rows = new Map(banks.map((b) => [b.id, blank(b)]));
  const none = blank(null);
  const R = (id) => rows.get(id) ?? none;
  for (const x of balances) {
    const r = rows.get(x.bank_id);
    if (r && (r.asOf == null || x.as_of > r.asOf || (x.as_of === r.asOf && x.id > r.balId))) Object.assign(r, { balance: Number(x.amount), asOf: x.as_of, balId: x.id });
  }
  const after = (bankId, d) => { const r = rows.get(bankId); return !!r && (!r.asOf || d > r.asOf); };
  const got = new Map(), paid = new Map();
  for (const e of entries) {
    const amt = Number(e.amount);
    if (e.kind === 'IN') { got.set(e.receipt_id, (got.get(e.receipt_id) || 0) + amt); if (after(e.bank_id, e.date)) R(e.bank_id).since += amt; }
    else { paid.set(e.payment_id, (paid.get(e.payment_id) || 0) + amt); if (after(e.bank_id, e.date)) R(e.bank_id).since -= amt; }
  }
  for (const r of receipts) {
    if (r.status === 'CANCELLED' || r.disputed) continue;
    const left = Number(r.amount) - (got.get(r.id) || 0);
    if (left <= 0 || !within(r.expected_date) || (!uncertain && r.certainty === 'UNCERTAIN')) continue;
    const row = R(r.bank_id); row.receive += left;
    row.items.push({ kind: 'IN', id: r.id, date: r.expected_date, name: r.party, ref: r.ref, amount: left, overdue: r.expected_date < today, uncertain: r.certainty === 'UNCERTAIN' });
  }
  for (const p of payments) {
    if (p.status === 'CANCELLED' || (approvedOnly && !p.approved)) continue;
    const left = Number(p.amount) - (paid.get(p.id) || 0);
    if (left <= 0) continue;
    const row = R(p.bank_id);
    if (p.emi_id && within(p.hold_from ?? p.due_date)) { row.held += left; row.holds.push({ id: p.id, name: p.payee, date: p.due_date, amount: left }); }
    if (!within(p.due_date)) continue;
    row.pay += left;
    row.items.push({ kind: 'OUT', id: p.id, date: p.due_date, name: p.payee, ref: p.ref, category: p.category, amount: left, overdue: p.due_date < today, approved: !!p.approved, emi: !!p.emi_id });
  }
  const list = [...rows.values(), ...(none.receive || none.pay ? [none] : [])];
  for (const r of list) { r.today = (r.balance || 0) + r.since; r.final = r.today + r.receive - r.pay; r.free = r.today - r.held; r.items.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)); delete r.balId; }
  const total = list.reduce((s, r) => ({ today: s.today + r.today, receive: s.receive + r.receive, pay: s.pay + r.pay, final: s.final + r.final, held: s.held + r.held, free: s.free + r.free }), { today: 0, receive: 0, pay: 0, final: 0, held: 0, free: 0 });
  // day by day: where the total goes, and its lowest point
  const days = new Map();
  for (const r of list) for (const i of r.items) { const d = i.date < today ? today : i.date; days.set(d, (days.get(d) || 0) + (i.kind === 'IN' ? i.amount : -i.amount)); }
  let run = total.today, low = { date: today, amount: total.today };
  const timeline = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, change]) => { run += change; if (run < low.amount) low = { date, amount: run }; return { date, change, balance: run }; });
  return { rows: list, total, timeline, lowest: low, unverified: list.filter((r) => r.id != null && r.balance == null).length };
}
