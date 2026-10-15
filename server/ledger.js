// Bank statements for a period — a pure function of the balances entered and the money actually received and paid.
// Pending receipts and payments never appear here: only entries (money that really moved) change a balance.
//
// As in balance.js, a balance entered for a day already includes everything dated on or before that day, so
//   balance at the end of day D = the latest balance entered on or before D
//                                 + received − paid dated after that balance, up to and including D
//   opening     = balance at the end of the day before the period
//   received    = money in during the period · paid = money out during the period
//   closing     = balance at the end of the period's last day
//   corrections = closing − (opening + received − paid): a balance entered inside the period that differs from the
//                 running figure (bank charges or interest not recorded, say). Zero when everything was recorded.
// Before the first balance ever entered for an account, the balance is worked back from that first one using the money
// recorded in between — so starting to use the app mid-period gives the right opening, not a "correction".
import { addDays } from './money.js';

/**
 * banks: [{id, name, bank, last4}] · balances: [{id, bank_id, amount, as_of}] · entries: [{kind: 'IN'|'OUT', bank_id, amount, date}]
 * from, to: 'YYYY-MM-DD' (inclusive) · only: a bank id to limit to, or null for all
 */
export function bankStatements({ banks, balances, entries, from, to, only = null }) {
  const dayBefore = addDays(from, -1);
  const rows = banks.filter((b) => only == null || b.id === only).map((b) => {
    const snaps = balances.filter((x) => x.bank_id === b.id).sort((x, y) => x.as_of.localeCompare(y.as_of) || x.id - y.id);
    const moves = entries.filter((e) => e.bank_id === b.id);
    const signed = (e) => (e.kind === 'IN' ? Number(e.amount) : -Number(e.amount));
    const at = (d) => {
      let s = null;
      for (const x of snaps) if (x.as_of <= d) s = x;
      if (!s && snaps.length) { // before the first balance: work back from it
        const first = snaps[0];
        let v = Number(first.amount);
        for (const e of moves) if (e.date > d && e.date <= first.as_of) v -= signed(e);
        return v;
      }
      let v = s ? Number(s.amount) : 0;
      for (const e of moves) if ((!s || e.date > s.as_of) && e.date <= d) v += signed(e);
      return v;
    };
    let received = 0, paid = 0, count = 0;
    for (const e of moves) if (e.date >= from && e.date <= to) { count++; if (e.kind === 'IN') received += Number(e.amount); else paid += Number(e.amount); }
    const opening = at(dayBefore), closing = at(to);
    const lastBalance = snaps.filter((x) => x.as_of <= to).at(-1) ?? null;
    return {
      id: b.id, name: b.name, bank: `${b.bank} XXXX${b.last4}`, opening, received, paid, closing, corrections: closing - (opening + received - paid), count,
      balanceEntered: !!lastBalance, lastBalanceOn: lastBalance?.as_of ?? null,
    };
  });
  const total = rows.reduce((s, r) => ({
    opening: s.opening + r.opening, received: s.received + r.received, paid: s.paid + r.paid, closing: s.closing + r.closing, corrections: s.corrections + r.corrections, count: s.count + r.count,
  }), { opening: 0, received: 0, paid: 0, closing: 0, corrections: 0, count: 0 });
  return { rows, total };
}
