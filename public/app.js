// The screen: sign-in, and the day's position — bank balance − payments due + receipts expected.
// Amounts arrive from the server in paise and are typed in as rupees.

const app = document.getElementById('app'), dlg = document.getElementById('dlg');
const S = { user: null, today: '', date: '', approvedOnly: false, uncertain: true, pos: null };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const inr = (p) => {
  const n = Math.abs(p), r = Math.floor(n / 100), c = n % 100;
  return `${p < 0 ? '−' : ''}₹${r.toLocaleString('en-IN')}${c ? '.' + String(c).padStart(2, '0') : ''}`;
};
const money = (p, cls = '') => h('span', { class: `num ${cls} ${p < 0 ? 'neg' : ''}` }, inr(p));
const rupees = (p) => (p / 100).toFixed(2);
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const can = (role) => ({ viewer: 0, editor: 1, admin: 2 })[S.user.role] >= ({ viewer: 0, editor: 1, admin: 2 })[role];

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: { message: `The app’s server didn’t answer (${path} gave HTTP ${r.status}, not app data). Check that the server or the Vercel API function is running.` } }));
  if (r.status === 401 && S.user && !path.endsWith('/login')) { S.user = null; boot(); }
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Something went wrong.'), { code: j.error?.code });
  return j;
}

// fields: [{ name, label, type, value, options: [[value, text]], hint, required, min, max }]
function form(fields, submitLabel, onSubmit, { onCancel } = {}) {
  const err = h('p', { class: 'err', role: 'alert' });
  const inputs = {};
  const rows = fields.map((f) => {
    let input;
    if (f.type === 'select') input = h('select', { name: f.name, required: f.required }, f.options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, t)));
    else if (f.type === 'checkbox') return h('label', { class: 'check' }, inputs[f.name] = h('input', { type: 'checkbox', name: f.name, checked: !!f.value }), f.label);
    else input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, min: f.min, max: f.max, inputmode: f.type === 'money' ? 'decimal' : null, autocomplete: f.autocomplete || 'off', placeholder: f.placeholder });
    if (f.type === 'money') input.type = 'text';
    inputs[f.name] = input;
    return h('label', {}, h('span', {}, f.label), input, f.hint && h('small', { class: 'muted' }, f.hint));
  });
  const btn = h('button', { class: 'primary', type: 'submit' }, submitLabel);
  const el = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value]));
      btn.disabled = true; err.textContent = '';
      try { await onSubmit(values); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    },
  }, rows, err, h('div', { class: 'bar' }, btn, onCancel && h('button', { type: 'button', onclick: onCancel }, 'Cancel')));
  return el;
}

function openDialog(title, fields, submitLabel, onSubmit, intro, wide = false) {
  dlg.className = wide ? 'wide' : '';
  dlg.replaceChildren(...[h('h2', {}, title), intro && (intro instanceof Node ? intro : h('p', { class: 'muted' }, intro)), form(fields, submitLabel, async (v) => { await onSubmit(v); dlg.close(); await load(); }, { onCancel: () => dlg.close() })].filter(Boolean));
  dlg.showModal();
}
// asks before adding something that looks like a duplicate
const confirmDup = async (send) => {
  try { return await send(false); } catch (e) { if (e.code === 'duplicate' && confirm(e.message)) return send(true); throw e; }
};

// ── sign in / first-time setup ──
function authScreen(needsSetup) {
  const fields = needsSetup
    ? [{ name: 'name', label: 'Your name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with letters and numbers.' }]
    : [{ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' }, { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }];
  app.replaceChildren(h('div', { class: 'card narrow' },
    h('h1', {}, needsSetup ? 'Set up the app' : 'Sign in'),
    needsSetup && h('p', { class: 'muted' }, 'Create the admin account. You can add other people after this.'),
    form(fields, needsSetup ? 'Create account' : 'Sign in', async (v) => { S.user = (await api(needsSetup ? '/api/setup' : '/api/login', v)).user; await load(); })));
}

// ── the day's position ──
async function load() {
  const p = new URLSearchParams({ date: S.date, approvedOnly: S.approvedOnly ? '1' : '0', uncertain: S.uncertain ? '1' : '0' });
  try { S.pos = await api(`/api/position?${p}`); render(); }
  catch (e) { if (S.user) app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'neg' }, e.message), h('button', { onclick: load }, 'Try again'))); }
}

function render() {
  const P = S.pos, T = P.total, isToday = P.date === P.today;
  const bankOpts = P.banks.map((b) => [b.id, `${b.name} — ${b.bank} XXXX${b.last4}`]);
  const anyBank = [...bankOpts, ['', 'Not decided yet']]; // the first account is picked unless changed

  const warnings = [];
  if (!P.banks.length) warnings.push(can('admin') ? 'Add your bank accounts to start (“+ Account”).' : 'No bank accounts yet — ask an admin to add them.');
  for (const r of P.rows) {
    if (r.id == null) continue;
    if (r.balance == null) warnings.push(`${r.name}: no bank balance entered yet, so it counts as ₹0.`);
    else if (r.asOf < addDays(P.today, -1)) warnings.push(`${r.name}: the bank balance was last entered for ${nice(r.asOf)}. Update it so today starts from the right figure.`);
  }
  if (S.approvedOnly) warnings.push('Showing approved payments only — payments still waiting for approval are left out.');

  // ordinary payments that only fit by using EMI money, in date order per account
  const needsEmi = new Set();
  for (const r of P.rows) if (r.held > 0) {
    let run = 0;
    for (const i of r.items) if (i.kind === 'OUT' && !i.emi && (run += i.amount) > r.free) needsEmi.add(i.id);
  }
  const count = (kind) => P.rows.reduce((n, r) => n + r.items.filter((i) => i.kind === kind).length, 0);

  const tile = (cls, label, p, sub) => h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-lbl' }, label), h('div', { class: `tile-amt ${p < 0 ? 'neg' : ''}` }, inr(p)), sub && h('div', { class: 'tile-sub' }, sub));
  const hero = h('header', { class: 'hero' },
    h('div', { class: 'hero-top' },
      h('div', {}, h('div', { class: 'eyebrow' }, isToday ? `Today · ${nice(P.date)}` : `Looking ahead to ${nice(P.date)}`), h('h1', {}, isToday ? 'Today’s bank position' : 'Bank position')),
      h('div', { class: 'who' }, h('span', { class: 'avatar' }, S.user.name.trim().slice(0, 1).toUpperCase()), h('span', { class: 'who-name' }, S.user.name, h('small', {}, S.user.role)),
        h('button', { class: 'ghost', onclick: async () => { await api('/api/logout', {}); S.user = null; boot(); } }, 'Sign out'))),
    h('div', { class: 'tiles' },
      tile('t-bal', 'Bank balance now', T.today, `${P.rows.filter((r) => r.id != null).length} account(s)`),
      tile('t-pay', '− Payments to make', T.pay, `${count('OUT')} payment(s)`),
      tile('t-rec', '+ Receipts due', T.receive, `${count('IN')} receipt(s)`),
      tile(T.final < 0 ? 't-fin bad' : 't-fin', isToday ? '= Closing position today' : '= Closing position', T.final, T.final < 0 ? `Short by ${inr(-T.final)}` : 'After all of the above')),
    T.held > 0 && h('div', { class: 'hold-strip' },
      h('span', { class: 'badge-emi' }, 'EMI HOLD'),
      h('span', {}, h('strong', {}, inr(T.held)), ' is held for EMIs and can’t be paid to anyone else: ',
        P.rows.flatMap((r) => r.holds.map((x) => `${x.name} ${inr(x.amount)} (${x.date < P.today ? 'overdue' : x.date === P.today ? 'due today' : 'due ' + nice(x.date)}, ${r.name})`)).join(' · ')),
      h('span', { class: 'grow' }),
      h('span', {}, 'Free to pay others now: ', h('strong', { class: T.free < 0 ? 'neg' : '' }, inr(T.free)))));

  const controls = h('div', { class: 'card toolbar' },
    h('div', { class: 'bar' },
      h('label', { class: 'check' }, 'Up to', h('input', { type: 'date', value: S.date, min: P.today, onchange: (e) => { S.date = e.target.value || P.today; load(); } })),
      !isToday && h('button', { class: 'small', onclick: () => { S.date = P.today; load(); } }, 'Back to today'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.approvedOnly, onchange: (e) => { S.approvedOnly = e.target.checked; load(); } }), 'Approved payments only'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.uncertain, onchange: (e) => { S.uncertain = e.target.checked; load(); } }), 'Count uncertain receipts')),
    h('div', { class: 'bar' },
      can('editor') && P.banks.length > 0 && h('button', { class: 'c-blue', onclick: () => balanceDialog(bankOpts) }, 'Enter bank balance'),
      can('editor') && h('button', { class: 'c-red', onclick: () => paymentDialog(anyBank) }, '+ Payment'),
      can('editor') && h('button', { class: 'c-green', onclick: () => receiptDialog(anyBank) }, '+ Receipt'),
      P.banks.length > 0 && h('button', { class: 'c-amber', onclick: () => emisDialog(bankOpts) }, 'EMIs'),
      can('admin') && h('button', { onclick: bankDialog }, '+ Account'),
      can('admin') && h('button', { onclick: usersDialog }, 'Users')));

  const alerts = [
    ...P.rows.filter((r) => r.id != null && r.final < 0 && T.final >= 0).map((r) => ['bad', `${r.name} will be short by ${inr(-r.final)}. Transfer money into it before the payments go out.`]),
    ...P.rows.filter((r) => r.held > 0 && r.free < 0).map((r) => ['bad', `${r.name} doesn’t have enough for its EMIs: ${inr(r.held)} is held but the balance is ${inr(r.today)}. Bring in ${inr(-r.free)}.`]),
    needsEmi.size > 0 && ['warn', `${needsEmi.size} payment(s) can only be paid with money held for EMIs, so they will be refused until money comes in.`],
    ...warnings.map((w) => ['warn', w]),
  ].filter(Boolean);
  const alertBox = alerts.length > 0 && h('div', { class: 'alerts' }, alerts.map(([k, t]) => h('div', { class: `alert ${k}` }, t)));

  const hasHold = P.rows.some((r) => r.held > 0);
  const accounts = h('section', { class: 'card' }, h('h2', {}, h('span', { class: 'dot d-blue' }), 'By account'), h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'num' }, 'Balance now'),
      hasHold && h('th', { class: 'num' }, 'Held for EMI'), hasHold && h('th', { class: 'num' }, 'Free now'),
      h('th', { class: 'num' }, '− To pay'), h('th', { class: 'num' }, '+ To receive'), h('th', { class: 'num' }, '= Closing'))),
    h('tbody', {}, P.rows.map((r) => h('tr', {},
      h('td', {}, h('strong', {}, r.name), h('div', { class: 'muted small' }, r.id == null ? 'Choose an account for these items' : `${r.bank}${r.asOf ? ` · balance for ${nice(r.asOf)}` : ' · no balance yet'}`)),
      h('td', { class: 'num' }, money(r.today)),
      hasHold && h('td', { class: 'num' }, r.held ? money(r.held, 'amber') : '—'), hasHold && h('td', { class: 'num' }, money(r.free)),
      h('td', { class: 'num' }, money(r.pay, r.pay ? 'red' : '')), h('td', { class: 'num' }, money(r.receive, r.receive ? 'pos' : '')),
      h('td', { class: 'num' }, h('strong', {}, money(r.final)))))),
    h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'num' }, money(T.today)),
      hasHold && h('td', { class: 'num' }, money(T.held, 'amber')), hasHold && h('td', { class: 'num' }, money(T.free)),
      h('td', { class: 'num' }, money(T.pay, 'red')), h('td', { class: 'num' }, money(T.receive, 'pos')), h('td', { class: 'num' }, money(T.final)))))));

  const items = P.rows.flatMap((r) => r.items.map((i) => ({ ...i, account: r.id == null ? 'Account not decided' : r.name, bankId: r.id, needsEmi: i.kind === 'OUT' && needsEmi.has(i.id) })));
  const list = (kind, dot, title, empty) => {
    const rows = items.filter((i) => i.kind === kind);
    const sum = rows.reduce((s, i) => s + i.amount, 0);
    return h('section', { class: 'card' },
      h('h2', {}, h('span', { class: `dot ${dot}` }), title, h('span', { class: 'count' }, rows.length), h('span', { class: 'grow' }), money(sum, kind === 'OUT' ? 'red' : 'pos')),
      rows.length ? rows.map((i) => itemRow(i, bankOpts)) : h('p', { class: 'empty' }, empty));
  };

  app.replaceChildren(...[hero, controls, alertBox, h('div', { class: 'cols' },
    list('OUT', 'd-red', isToday ? 'Payments to make today' : 'Payments to make', 'Nothing to pay.'),
    list('IN', 'd-green', isToday ? 'Receipts due today' : 'Receipts due', 'Nothing expected.')), accounts].filter(Boolean));
}

function itemRow(i, bankOpts) {
  const out = i.kind === 'OUT', kind = out ? 'payments' : 'receipts';
  return h('div', { class: `item ${i.emi ? 'i-emi' : out ? 'i-out' : 'i-in'}` },
    h('div', { class: 'item-main' },
      h('div', {}, h('strong', {}, i.name), i.ref && h('span', { class: 'muted' }, ` · ${i.ref}`)),
      h('div', { class: 'chips' },
        i.emi ? h('span', { class: 'chip c-amber' }, 'EMI') : i.category && h('span', { class: 'chip' }, i.category),
        i.overdue && h('span', { class: 'chip c-red' }, `overdue · ${nice(i.date)}`),
        !i.overdue && i.date !== S.pos.today && h('span', { class: 'chip c-blue' }, nice(i.date)),
        out && !i.approved && h('span', { class: 'chip c-violet' }, 'not approved'),
        i.uncertain && h('span', { class: 'chip c-violet' }, 'uncertain'),
        i.needsEmi && h('span', { class: 'chip c-red', title: 'Paying this now would use money held for EMIs, so it will be refused.' }, 'blocked by EMI hold'),
        h('span', { class: 'muted small' }, i.account)),
      h('div', { class: 'acts' },
        can('editor') && h('button', { class: `small ${out ? 'solid-red' : 'solid-green'}`, onclick: () => settleDialog(i, bankOpts) }, out ? 'Mark paid' : 'Mark received'),
        out && !i.approved && can('admin') && h('button', { class: 'small', onclick: () => act(`/api/payments/${i.id}/approve`, {}) }, 'Approve'),
        can('editor') && h('button', { class: 'small', onclick: () => { if (confirm(`Cancel “${i.name}”? It will no longer be counted.`)) act(`/api/${kind}/${i.id}/cancel`, {}); } }, 'Cancel'))),
    h('div', { class: 'item-amt' }, money(i.amount, i.emi ? 'amber' : out ? 'red' : 'pos')));
}

async function emisDialog(bankOpts) {
  let data;
  try { data = await api('/api/emis'); } catch (e) { return alert(e.message); }
  const list = h('div', { class: 'emi-list' },
    data.emis.length ? data.emis.map((e) => h('div', { class: `emi-row ${e.active ? '' : 'stopped'}` },
      h('div', {},
        h('strong', {}, e.lender), e.ref && h('span', { class: 'muted' }, ` · ${e.ref}`),
        h('div', { class: 'muted small' }, `${e.bank_name} · every month on day ${e.day}` +
          (e.hold_days ? ` · held from ${e.hold_days} day(s) before` : ' · held on the EMI day') +
          (e.active ? (e.next_due ? ` · next ${nice(e.next_due)}` : '') : ' · stopped'))),
      h('div', { class: 'emi-right' }, money(e.amount, 'amber'),
        e.active && can('editor') && h('button', { class: 'small', onclick: async () => {
          if (!confirm(`Stop the EMI “${e.lender}”? Instalments after today that have nothing paid will be removed.`)) return;
          try { await api(`/api/emis/${e.id}/stop`, {}); dlg.close(); await load(); emisDialog(bankOpts); } catch (x) { alert(x.message); }
        } }, 'Stop'))))
      : h('p', { class: 'empty' }, 'No EMIs yet.'),
    can('editor') && h('h3', {}, 'Add an EMI'));
  if (!can('editor')) {
    dlg.className = 'wide';
    dlg.replaceChildren(h('h2', {}, 'EMIs'), list, h('div', { class: 'bar' }, h('button', { onclick: () => dlg.close() }, 'Close')));
    return dlg.showModal();
  }
  openDialog('EMIs', [
    { name: 'lender', label: 'Lender / loan', placeholder: 'e.g. HDFC car loan', required: true },
    { name: 'amount', label: 'EMI amount (₹)', type: 'money', required: true },
    { name: 'bank_id', label: 'Paid from account', type: 'select', options: bankOpts, required: true },
    { name: 'start_date', label: 'Next EMI date', type: 'date', min: addDays(S.pos.today, -31), required: true, hint: 'It repeats on this day every month.' },
    { name: 'hold_days', label: 'Hold the money from', type: 'select', value: '0', options: [['0', 'The EMI day only'], ['1', '1 day before'], ['2', '2 days before'], ['3', '3 days before'], ['5', '5 days before'], ['7', '7 days before'], ['10', '10 days before'], ['15', '15 days before']],
      hint: 'While held, the app won’t let that money be paid to anyone else from this account.' },
    { name: 'end_date', label: 'Last EMI date (optional)', type: 'date' },
    { name: 'ref', label: 'Loan account no. (optional)' },
  ], 'Add EMI', (v) => api('/api/emis', v), list, true);
}

const act = async (path, body) => { try { await api(path, body); await load(); } catch (e) { alert(e.message); } };

// ── dialogs ──
function settleDialog(i, bankOpts) {
  const out = i.kind === 'OUT';
  openDialog(out ? `Mark paid: ${i.name}` : `Mark received: ${i.name}`, [
    { name: 'amount', label: 'Amount (₹)', type: 'money', value: rupees(i.amount), required: true, hint: `Still ${out ? 'to pay' : 'to receive'}: ${inr(i.amount)}. Enter less for a part ${out ? 'payment' : 'receipt'}.` },
    { name: 'bank_id', label: out ? 'Paid from' : 'Received in', type: 'select', value: i.bankId ?? (bankOpts.length === 1 ? bankOpts[0][0] : ''), options: [['', 'Choose…'], ...bankOpts], required: true },
    { name: 'date', label: 'Date in the bank', type: 'date', value: S.pos.today, max: S.pos.today, required: true },
    { name: 'ref', label: 'Bank reference (UTR / cheque no.)', required: true },
  ], 'Save', (v) => api(`/api/${out ? 'payments' : 'receipts'}/${i.id}/settle`, v));
}

function balanceDialog(bankOpts) {
  const yesterday = addDays(S.pos.today, -1);
  openDialog('Enter bank balance', [
    { name: 'bank_id', label: 'Account', type: 'select', options: bankOpts, required: true },
    { name: 'amount', label: 'Balance (₹)', type: 'money', required: true, hint: 'Use a minus sign for an overdraft, e.g. -25000.' },
    { name: 'as_of', label: 'Balance at the end of', type: 'date', value: yesterday, max: S.pos.today, required: true,
      hint: 'Normally yesterday’s closing balance (= this morning’s opening). If you take the live balance during the day, date it today: anything marked paid or received today is then treated as already in it.' },
    { name: 'note', label: 'Note (optional)' },
  ], 'Save', (v) => api('/api/balances', v));
}

const CATEGORIES = ['Vendor', 'Salary', 'Tax / GST / TDS', 'Rent', 'Loan / EMI', 'Utilities', 'Refund', 'Other'];
function paymentDialog(anyBank) {
  openDialog('Add a payment to make', [
    { name: 'payee', label: 'Pay to', required: true },
    { name: 'amount', label: 'Amount (₹)', type: 'money', required: true },
    { name: 'due_date', label: 'Pay on', type: 'date', value: S.date, required: true },
    { name: 'category', label: 'Category', type: 'select', options: CATEGORIES.map((c) => [c, c]), required: true },
    { name: 'bank_id', label: 'Pay from', type: 'select', options: anyBank },
    { name: 'ref', label: 'Invoice / bill no. (optional)' },
    { name: 'note', label: 'Note (optional)' },
    ...(can('admin') ? [{ name: 'approved', label: 'Approved', type: 'checkbox', value: true }] : []),
  ], 'Add payment', (v) => confirmDup((dup) => api('/api/payments', { ...v, confirmDuplicate: dup })));
}

function receiptDialog(anyBank) {
  openDialog('Add a receipt you expect', [
    { name: 'party', label: 'Received from', required: true },
    { name: 'amount', label: 'Amount (₹)', type: 'money', required: true },
    { name: 'expected_date', label: 'Expected on', type: 'date', value: S.date, required: true },
    { name: 'certainty', label: 'How sure', type: 'select', value: 'LIKELY', options: [['FIRM', 'Firm (confirmed)'], ['LIKELY', 'Likely'], ['UNCERTAIN', 'Uncertain']] },
    { name: 'bank_id', label: 'Into account', type: 'select', options: anyBank },
    { name: 'ref', label: 'Invoice no. (optional)' },
    { name: 'note', label: 'Note (optional)' },
  ], 'Add receipt', (v) => api('/api/receipts', v));
}

function bankDialog() {
  openDialog('Add a bank account', [
    { name: 'name', label: 'Name in this app', placeholder: 'e.g. Main current account', required: true },
    { name: 'bank', label: 'Bank', placeholder: 'e.g. HDFC Bank', required: true },
    { name: 'last4', label: 'Last 4 digits of the account number', required: true },
  ], 'Add account', (v) => api('/api/banks', v));
}

async function usersDialog() {
  let users;
  try { ({ users } = await api('/api/users')); } catch (e) { return alert(e.message); }
  openDialog('Users', [
    { name: 'name', label: 'Name', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'role', label: 'Role', type: 'select', value: 'editor', options: [['viewer', 'Viewer — can only look'], ['editor', 'Editor — adds and updates entries'], ['admin', 'Admin — also approves payments, adds accounts and users']] },
    { name: 'password', label: 'First password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with letters and numbers. Share it with them privately.' },
  ], 'Add user', (v) => api('/api/users', v), users.map((u) => `${u.name} (${u.role})`).join(' · '));
}

async function boot() {
  dlg.open && dlg.close();
  try {
    const s = await api('/api/state');
    S.today = s.today; S.date = S.date && S.date >= s.today ? S.date : s.today; S.user = s.user;
    if (!s.user) return authScreen(s.needsSetup);
    await load();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'card narrow' }, h('p', { class: 'neg' }, e.message), h('button', { onclick: boot }, 'Try again')));
  }
}
boot();
