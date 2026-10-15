// EMI due dates: the same day every month from the first EMI, moved back to the month's last day when the month is
// shorter (an EMI on the 31st falls on 30 Apr and 28/29 Feb).

/** emi: {day, start_date, end_date?} → 'YYYY-MM-DD' dates from the first EMI up to and including `through` */
export function emiDates(emi, through) {
  const out = [];
  let [y, m] = emi.start_date.split('-').map(Number);
  for (let i = 0; i < 1200; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(emi.day, last)).padStart(2, '0')}`;
    if (d > through || (emi.end_date && d > emi.end_date)) break;
    if (d >= emi.start_date) out.push(d);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
