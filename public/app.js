// The screen: sign-in, and the day's position — bank balance − payments due + receipts expected.
// Amounts arrive from the server in paise and are typed in as rupees.

const app = document.getElementById('app'), dlg = document.getElementById('dlg');
const S = { user: null, today: '', date: '', approvedOnly: false, uncertain: true, pos: null };
// what one signed-in person was looking at; cleared on sign-out so the next person starts fresh
const fresh = () => Object.assign(S, { view: 'position', pf: { status: 'active', position: '', q: '' }, af: {}, act: null, tf: null, ef: null, dash: null, notes: null, notesAt: 0, approvedOnly: false, uncertain: true });
fresh();

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
  if (r.status === 401 && S.user && !path.endsWith('/login')) { S.user = null; fresh(); boot(); }
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
const confirmCode = async (code, send) => {
  try { return await send(false); } catch (e) { if (e.code === code && confirm(e.message)) return send(true); throw e; }
};
const confirmDup = async (send) => {
  try { return await send(false); } catch (e) { if (e.code === 'duplicate' && confirm(e.message)) return send(true); throw e; }
};

// ── sign in / first-time setup ──
function authScreen(needsSetup) {
  document.body.classList.remove('has-shell', 'nav-open');
  const fields = needsSetup
    ? [{ name: 'name', label: 'Your name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with letters and numbers.' }]
    : [{ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' }, { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }];
  app.replaceChildren(h('div', { class: 'card narrow' },
    h('h1', {}, needsSetup ? 'Set up the app' : 'Sign in'),
    needsSetup && h('p', { class: 'muted' }, 'Create the admin account. You can add other people after this.'),
    form(fields, needsSetup ? 'Create account' : 'Sign in', async (v) => { S.user = (await api(needsSetup ? '/api/setup' : '/api/login', v)).user; await load(); })));
}

// ── the page shown: the dashboard, Transactions, EMIs, People, Positions, or the activity log ──
async function load() {
  if (S.view === 'activity' && !can('admin')) S.view = 'position';
  try { await ({ position: loadPosition, transactions: loadTransactions, emis: loadEmis, people: loadPeople, positions: loadPositions, activity: loadActivity })[S.view](); }
  catch (e) { if (S.user) app.replaceChildren(topBar(), h('div', { class: 'card' }, h('p', { class: 'neg' }, e.message), h('button', { onclick: load }, 'Try again'))); }
}

// simple line icons (stroke paths on a 24×24 grid)
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6', swap: 'M4 7h14l-4-4M20 17H6l4 4', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  badge: 'M3 7h18v13H3zM9 7V4h6v3M3 13h18', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  menu: 'M3 6h18M3 12h18M3 18h18', wallet: 'M3 7h18v13H3zM16 14h2M3 7l3-4h12l3 4',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', check: 'M20 6L9 17l-5-5', alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  down: 'M12 4v14M6 12l6 6 6-6', up: 'M12 20V6M6 12l6-6 6 6', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
};
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  p.setAttribute('d', ICONS[name]); svg.append(p);
  return svg;
}
const navKey = () => (S.view === 'transactions' ? `transactions:${S.tf?.view ?? 'history'}` : S.view);
function go(key) {
  document.body.classList.remove('nav-open');
  const [view, sub] = key.split(':');
  if (view === 'transactions') S.tf = { ...(S.tf ?? txDefaults()), view: sub };
  S.view = view;
  load();
}

// the fixed left sidebar and the header (reminders bell, who is signed in); on phones the sidebar slides in
function topBar() {
  document.body.classList.add('has-shell');
  const items = [['position', 'Dashboard', 'home'], ['transactions:records', 'Receipts & Payments', 'swap'], ['transactions:history', 'Transaction History', 'list'],
    ['emis', 'EMI Management', 'calendar'], ['people', 'People', 'users'], ['positions', 'Positions', 'badge'], can('admin') && ['activity', 'Activity Log', 'shield']].filter(Boolean);
  const unread = S.notes?.unread ?? 0;
  if (Date.now() - S.notesAt > 60000) refreshNotes();
  return h('div', { class: 'chrome' },
    h('aside', { class: 'sidebar', 'aria-label': 'Main menu' },
      h('div', { class: 'brand' }, icon('wallet'), h('div', {}, h('strong', {}, 'Finance'), h('small', {}, 'Bank, EMIs & people'))),
      h('nav', {}, items.map(([k, t, ic]) => h('button', { class: `nav-item ${navKey() === k ? 'on' : ''}`, 'aria-current': navKey() === k ? 'page' : null, onclick: () => go(k) }, icon(ic), h('span', {}, t))))),
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }),
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
      h('span', { class: 'grow' }),
      h('div', { class: 'bell-wrap' },
        h('button', { class: 'icon-btn bell', id: 'bell', 'aria-label': `Reminders${unread ? `, ${unread} unread` : ''}`, onclick: toggleNotes }, icon('bell'), h('span', { class: 'badge', id: 'bell-badge', hidden: !unread }, unread > 99 ? '99+' : unread)),
        h('div', { class: 'notes-panel', id: 'notes', hidden: true })),
      h('div', { class: 'who' }, h('span', { class: 'avatar' }, S.user.name.trim().slice(0, 1).toUpperCase()), h('span', { class: 'who-name' }, S.user.name, h('small', {}, S.user.role)),
        h('button', { class: 'small', onclick: async () => { await api('/api/logout', {}); S.user = null; fresh(); document.body.classList.remove('has-shell', 'nav-open'); boot(); } }, 'Sign out'))));
}

// in-app reminders: fetched at most once a minute; the bell shows how many are unread
async function refreshNotes() {
  S.notesAt = Date.now();
  try { S.notes = await api('/api/notifications'); } catch { return; }
  const b = document.getElementById('bell-badge');
  if (b) { b.hidden = !S.notes.unread; b.textContent = S.notes.unread > 99 ? '99+' : S.notes.unread; }
  const p = document.getElementById('notes');
  if (p && !p.hidden) fillNotes(p);
}
function toggleNotes() {
  const p = document.getElementById('notes');
  p.hidden = !p.hidden;
  if (!p.hidden) { fillNotes(p); refreshNotes(); }
}
function fillNotes(p) {
  const items = S.notes?.items ?? [];
  const tone = { overdue: 'c-red', shortfall: 'c-red', due: 'c-amber', upcoming: 'c-blue' };
  p.replaceChildren(
    h('div', { class: 'notes-head' }, h('strong', {}, 'Reminders'),
      items.some((n) => !n.read_at) && h('button', { class: 'small', onclick: async () => { await api('/api/notifications/read', { all: true }); S.notesAt = 0; await refreshNotes(); } }, 'Mark all read')),
    // replaceChildren takes each element as its own argument, so the list is spread
    ...(items.length ? items.map((n) => h('button', { class: `note ${n.read_at ? '' : 'unread'}`, onclick: async () => {
      if (!n.read_at) await api('/api/notifications/read', { id: n.id }).catch(() => {});
      S.notesAt = 0; go('emis');
    } }, h('span', { class: `chip ${tone[n.kind] ?? ''}` }, n.kind), h('span', { class: 'note-title' }, n.title), h('span', { class: 'muted small' }, when(n.created_at))))
      : [h('p', { class: 'empty' }, 'No reminders yet.')]));
}

// ── the day's position ──
async function loadPosition() {
  const p = new URLSearchParams({ date: S.date, approvedOnly: S.approvedOnly ? '1' : '0', uncertain: S.uncertain ? '1' : '0' });
  [S.pos, S.dash] = await Promise.all([api(`/api/position?${p}`), api('/api/dashboard')]);
  render();
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
      h('div', {}, h('div', { class: 'eyebrow' }, isToday ? `Today · ${nice(P.date)}` : `Looking ahead to ${nice(P.date)}`), h('h1', {}, isToday ? 'Today’s bank position' : 'Bank position'))),
    h('div', { class: 'tiles' },
      tile('t-bal', 'Bank balance now', T.today, `${P.rows.filter((r) => r.id != null).length} account(s)`),
      tile('t-pay', '− Payments to make', T.pay, `${count('OUT')} payment(s)`),
      tile('t-rec', '+ Receipts due', T.receive, `${count('IN')} receipt(s)`),
      tile(T.final < 0 ? 't-fin bad' : 't-fin', isToday ? '= Closing position today' : '= Closing position', T.final, T.final < 0 ? `Short by ${inr(-T.final)}` : 'After all of the above')),
    T.held > 0 && h('div', { class: 'hold-strip' },
      h('span', { class: 'badge-emi' }, 'EMI RESERVE'),
      h('span', {}, h('strong', {}, inr(T.held)), ' is reserved for EMIs in this app (your bank isn’t holding it) — the app won’t let it be paid to anyone else: ',
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
      P.banks.length > 0 && h('button', { class: 'c-amber', onclick: () => go('emis') }, 'EMIs'),
      can('admin') && h('button', { onclick: bankDialog }, '+ Account'),
      can('admin') && h('button', { onclick: usersDialog }, 'Users')));

  const alerts = [
    ...P.rows.filter((r) => r.id != null && r.final < 0 && T.final >= 0).map((r) => ['bad', `${r.name} will be short by ${inr(-r.final)}. Transfer money into it before the payments go out.`]),
    ...shortfallAlerts(S.dash?.shortfalls ?? []).map((t) => ['bad', t]),
    needsEmi.size > 0 && ['warn', `${needsEmi.size} payment(s) can only be paid with money reserved for EMIs, so the app will refuse them until money comes in.`],
    ...warnings.map((w) => ['warn', w]),
  ].filter(Boolean);
  const alertBox = alerts.length > 0 && h('div', { class: 'alerts' }, alerts.map(([k, t]) => h('div', { class: `alert ${k}` }, t)));

  const hasHold = P.rows.some((r) => r.held > 0);
  const accounts = h('section', { class: 'card' }, h('h2', {}, h('span', { class: 'dot d-blue' }), 'By account'), h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'num' }, 'Balance now'),
      hasHold && h('th', { class: 'num' }, 'Reserved for EMI'), hasHold && h('th', { class: 'num' }, 'Free now'),
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

  app.replaceChildren(...[topBar(), summaryCards(S.dash), hero, controls, alertBox, h('div', { class: 'cols' },
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
        i.needsEmi && h('span', { class: 'chip c-red', title: 'Paying this now would use money reserved for EMIs, so the app will refuse it.' }, 'blocked: EMI reserve'),
        h('span', { class: 'muted small' }, i.account)),
      h('div', { class: 'acts' },
        can('editor') && h('button', { class: `small ${out ? 'solid-red' : 'solid-green'}`, onclick: () => settleDialog(i, bankOpts) }, out ? 'Mark paid' : 'Mark received'),
        out && !i.approved && can('admin') && h('button', { class: 'small', onclick: () => act(`/api/payments/${i.id}/approve`, {}) }, 'Approve'),
        can('editor') && h('button', { class: 'small', onclick: () => { if (confirm(`Cancel “${i.name}”? It will no longer be counted.`)) act(`/api/${kind}/${i.id}/cancel`, {}); } }, 'Cancel'))),
    h('div', { class: 'item-amt' }, money(i.amount, i.emi ? 'amber' : out ? 'red' : 'pos')));
}

const act = async (path, body) => { try { await api(path, body); await load(); } catch (e) { alert(e.message); } };

// ── dialogs ──
function settleDialog(i, bankOpts) {
  const out = i.kind === 'OUT';
  openDialog(out ? `Mark paid: ${i.name}` : `Mark received: ${i.name}`, [
    { name: 'amount', label: 'Amount (₹)', type: 'money', value: rupees(i.amount), required: true, hint: `Still ${out ? 'to pay' : 'to receive'}: ${inr(i.amount)}. Enter less for a part ${out ? 'payment' : 'receipt'}.` },
    { name: 'bank_id', label: out ? 'Paid from' : 'Received in', type: 'select', value: i.bankId ?? (bankOpts.length === 1 ? bankOpts[0][0] : ''), options: [['', 'Choose…'], ...bankOpts], required: true },
    { name: 'date', label: 'Date in the bank', type: 'date', value: S.today, max: S.today, required: true },
    { name: 'ref', label: 'Bank reference (UTR / cheque no.)', required: true },
  ], 'Save', (v) => confirmCode('insufficient', (ok) => api(`/api/${out ? 'payments' : 'receipts'}/${i.id}/settle`, { ...v, confirmShortfall: ok })));
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
  ], 'Add receipt', (v) => confirmDup((dup) => api('/api/receipts', { ...v, confirmDuplicate: dup })));
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

// ── Transactions: money received and paid, bank statements for a period, reports and exports ──
// Only money actually received or paid moves a balance; pending receipts and payments are shown apart.
const monthStart = (d) => `${d.slice(0, 8)}01`;
function period(preset, today = S.today) {
  const [y, m] = today.split('-').map(Number);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'lastmonth') { const end = addDays(monthStart(today), -1); return { from: monthStart(end), to: end }; }
  if (preset === 'fy') return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today }; // Indian financial year, April to March
  return { from: monthStart(today), to: today };
}
const txDefaults = () => ({ preset: 'month', ...period('month'), bank: '', type: '', status: '', q: '', view: 'history' });
const txQuery = (extra = {}) => {
  const f = S.tf;
  return new URLSearchParams(Object.entries({ view: f.view, from: f.from, to: f.to, bank: f.bank, type: f.type, status: f.view === 'records' ? f.status : '', q: f.q, ...extra }).filter(([, v]) => v));
};

async function loadTransactions() {
  if (!S.tf) S.tf = txDefaults();
  const [sum, list] = await Promise.all([api(`/api/transactions/summary?${txQuery({ view: '' })}`), api(`/api/transactions?${txQuery()}`)]);
  keepFocus(() => renderTransactions(sum, list.rows));
}

const STATE_LABEL = { pending: 'Pending', partial: 'Partly settled', completed: 'Completed', cancelled: 'Cancelled' };
const STATE_TONE = { pending: 'c-amber', partial: 'c-blue', completed: 'c-green', cancelled: '' };

function renderTransactions(sum, rows) {
  const f = S.tf, T = sum.total, accounts = sum.accounts;
  const bankOpts = accounts.map((b) => [b.id, `${b.name} — ${b.bank} XXXX${b.last4}`]);
  const set = (k) => (e) => { S.tf = { ...S.tf, [k]: e.target.value }; load(); };
  const setDate = (k) => (e) => { if (e.target.value) { S.tf = { ...S.tf, [k]: e.target.value, preset: 'custom' }; load(); } };

  const filters = h('div', { class: 'card toolbar' }, h('div', { class: 'bar grow' },
    h('select', { 'aria-label': 'Period', onchange: (e) => { const p = e.target.value; S.tf = { ...S.tf, preset: p, ...(p === 'custom' ? {} : period(p)) }; load(); } },
      [['today', 'Today'], ['month', 'This month'], ['lastmonth', 'Last month'], ['fy', 'This financial year'], ['custom', 'Custom dates']].map(([v, t]) => h('option', { value: v, selected: f.preset === v }, t))),
    h('label', { class: 'check' }, 'From', h('input', { type: 'date', name: 'from', value: f.from, max: f.to, onchange: setDate('from') })),
    h('label', { class: 'check' }, 'To', h('input', { type: 'date', name: 'to', value: f.to, min: f.from, onchange: setDate('to') })),
    h('select', { 'aria-label': 'Bank account', onchange: set('bank') }, [['', 'All bank accounts'], ...accounts.map((b) => [String(b.id), b.name])].map(([v, t]) => h('option', { value: v, selected: f.bank === v }, t))),
    h('select', { 'aria-label': 'Type', onchange: set('type') }, [['', 'Receipts and payments'], ['IN', 'Receipts only'], ['OUT', 'Payments only']].map(([v, t]) => h('option', { value: v, selected: f.type === v }, t))),
    f.view === 'records' && h('select', { 'aria-label': 'Status', onchange: set('status') }, [['', 'Any status'], ['pending', 'Pending'], ['partial', 'Partly settled'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([v, t]) => h('option', { value: v, selected: f.status === v }, t))),
    h('input', { type: 'search', name: 'txq', class: 'search', placeholder: 'Search party, reference, description', value: f.q, oninput: onSearch((v) => { S.tf = { ...S.tf, q: v }; }), 'aria-label': 'Search transactions' })));

  const tile = (cls, label, p, sub) => h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-lbl' }, label), h('div', { class: `tile-amt ${p < 0 ? 'neg' : ''}` }, inr(p)), sub && h('div', { class: 'tile-sub' }, sub));
  const P = sum.pending;
  const summary = h('header', { class: 'hero' },
    h('div', { class: 'hero-top' }, h('div', {},
      h('div', { class: 'eyebrow' }, sum.from === sum.to ? nice(sum.from) : `${nice(sum.from)} – ${nice(sum.to)}`),
      h('h1', {}, f.bank ? `${accounts.find((b) => String(b.id) === f.bank)?.name ?? 'Bank'} balance` : 'Combined bank balance'))),
    h('div', { class: 'tiles' },
      tile('t-fin', sum.to === sum.today ? 'Balance now' : `Balance on ${nice(sum.to)}`, T.closing, `Opening ${inr(T.opening)} on ${nice(addDays(sum.from, -1))}`),
      tile('t-rec', '+ Total received', T.received, `${sum.banks.reduce((n, b) => n + b.count, 0)} transaction(s) in the period`),
      tile('t-pay', '− Total paid', T.paid, 'Money that left the bank'),
      tile('t-bal', 'Net for the period', T.received - T.paid, T.corrections ? `Balance corrections ${inr(T.corrections)}` : 'Received − paid')),
    (P.IN.count > 0 || P.OUT.count > 0) && h('div', { class: 'hold-strip pending-strip' },
      h('span', { class: 'badge-emi' }, 'PENDING'),
      h('span', {}, 'Not in the balances above until received or paid: ', h('strong', { class: 'pos' }, inr(P.IN.amount)), ` to receive (${P.IN.count}) · `, h('strong', { class: 'red' }, inr(P.OUT.amount)), ` to pay (${P.OUT.count}).`)));

  const line = (label, p, cls = '', title) => h('div', { class: 'bc-line', title }, h('span', { class: 'muted' }, label), money(p, cls));
  const cards = sum.banks.length
    ? h('div', { class: 'bank-cards' }, sum.banks.map((b) => h('section', { class: 'bank-card' },
      h('div', { class: 'bc-head' }, h('div', {}, h('strong', {}, b.name), h('div', { class: 'muted small' }, b.bank)),
        !b.balanceEntered && h('span', { class: 'chip c-amber', title: 'Enter a bank balance on the Bank position page so this starts from the right figure.' }, 'no balance entered')),
      h('div', { class: `bc-amt ${b.closing < 0 ? 'neg' : ''}` }, inr(b.closing)),
      line(`Opening (${nice(addDays(sum.from, -1))})`, b.opening),
      line('+ Received', b.received, 'pos'),
      line('− Paid', b.paid, 'red'),
      b.corrections !== 0 && line('± Balance corrections', b.corrections, 'amber', 'A balance entered during the period differs from the running figure — e.g. bank charges or interest not recorded here.'),
      h('div', { class: 'bc-line total' }, h('span', {}, sum.to === sum.today ? '= Current balance' : `= Balance on ${nice(sum.to)}`), money(b.closing)))))
    : h('div', { class: 'card' }, h('p', { class: 'empty' }, can('admin') ? 'No bank accounts yet — add them on the Bank position page (“+ Account”).' : 'No bank accounts yet.'));

  const exportBtn = (format, label) => h('button', { class: 'small', onclick: () => {
    const a = h('a', { href: `/api/transactions/export?${txQuery({ format })}`, download: '' });
    document.body.append(a); a.click(); a.remove();
  } }, label);
  const seg = h('div', { class: 'toolbar-row' },
    h('div', { class: 'seg', role: 'tablist' }, [['history', 'Transaction history'], ['records', 'All receipts & payments']].map(([v, t]) =>
      h('button', { class: f.view === v ? 'on' : '', role: 'tab', 'aria-selected': f.view === v ? 'true' : 'false', onclick: () => { if (f.view !== v) { S.tf = { ...S.tf, view: v }; load(); } } }, t))),
    h('div', { class: 'bar' }, h('span', { class: 'muted small' }, `${rows.length} row(s)`), exportBtn('csv', 'Export CSV'), exportBtn('xlsx', 'Export Excel')));

  const table = f.view === 'history' ? historyTableEl(rows) : recordsTableEl(rows, bankOpts);
  app.replaceChildren(topBar(),
    pageHead('Receipts, payments & balances', 'Balances move only when money is received or paid. Pending items are shown separately.',
      can('editor') && h('button', { class: 'c-green', onclick: () => txDialog('IN', accounts) }, '+ Receipt'),
      can('editor') && h('button', { class: 'c-red', onclick: () => txDialog('OUT', accounts) }, '+ Payment')),
    filters, summary, cards, h('section', { class: 'card' }, seg, table));
}

const txDesc = (r) => r.note || (r.emi ? 'EMI' : r.category) || '';
function historyTableEl(rows) {
  if (!rows.length) return h('p', { class: 'empty' }, 'No money received or paid in this period.');
  const inSum = rows.filter((r) => r.kind === 'IN').reduce((s, r) => s + r.amount, 0), outSum = rows.filter((r) => r.kind === 'OUT').reduce((s, r) => s + r.amount, 0);
  return h('div', { class: 'scroll' }, h('table', { class: 'tx' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Party / description'), h('th', {}, 'Bank account'), h('th', {}, 'Bank ref.'), h('th', {}, 'Invoice / bill'), h('th', { class: 'num' }, 'Amount'))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { class: 'nowrap' }, nice(r.date)),
      h('td', {}, h('span', { class: `chip ${r.kind === 'IN' ? 'c-green' : 'c-red'}` }, r.kind === 'IN' ? 'Received' : 'Paid')),
      h('td', {}, h('strong', {}, r.name), txDesc(r) && h('div', { class: 'muted small' }, txDesc(r))),
      h('td', {}, r.bank_name, h('div', { class: 'muted small' }, `${r.bank_label} XXXX${r.last4}`)),
      h('td', { class: 'nowrap' }, r.bank_ref),
      h('td', {}, r.doc_ref || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'num' }, h('strong', {}, money(r.kind === 'IN' ? r.amount : -r.amount, r.kind === 'IN' ? 'pos' : '')))))),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: '6' }, 'Received ', money(inSum, 'pos'), ' · Paid ', money(outSum, 'red')), h('td', { class: 'num' }, money(inSum - outSum))))));
}

function recordsTableEl(rows, bankOpts) {
  if (!rows.length) return h('p', { class: 'empty' }, 'Nothing matches these filters.');
  return h('div', { class: 'scroll' }, h('table', { class: 'tx' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Party / description'), h('th', {}, 'Bank account'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Settled'), h('th', { class: 'num' }, 'Outstanding'), h('th', {}, 'Status'), can('editor') && h('th', {}, ''))),
    h('tbody', {}, rows.map((r) => {
      const open = r.state === 'pending' || r.state === 'partial', left = r.amount - r.settled, out = r.kind === 'OUT';
      return h('tr', { class: r.state === 'cancelled' ? 'inactive' : '' },
        h('td', { class: 'nowrap' }, nice(r.date)),
        h('td', {}, h('span', { class: `chip ${out ? 'c-red' : 'c-green'}` }, out ? 'Payment' : 'Receipt')),
        h('td', {}, h('strong', {}, r.name), h('div', { class: 'muted small' }, [r.ref, txDesc(r), r.bank_refs && `bank ref. ${r.bank_refs}`].filter(Boolean).join(' · '))),
        h('td', {}, r.bank_name ?? h('span', { class: 'muted' }, 'Not decided')),
        h('td', { class: 'num' }, money(r.amount)),
        h('td', { class: 'num' }, r.settled ? money(r.settled, out ? 'red' : 'pos') : '—'),
        h('td', { class: 'num' }, open ? money(left, 'amber') : '—'),
        h('td', {}, h('span', { class: `chip ${STATE_TONE[r.state]}` }, STATE_LABEL[r.state]), r.last_date && r.state !== 'pending' && h('div', { class: 'muted small' }, `last ${nice(r.last_date)}`)),
        can('editor') && h('td', { class: 'acts-cell' }, open && [
          h('button', { class: `small ${out ? 'solid-red' : 'solid-green'}`, onclick: () => settleDialog({ kind: r.kind, id: r.id, name: r.name, amount: left, bankId: r.bank_id }, bankOpts) }, out ? 'Mark paid' : 'Mark received'),
          h('button', { class: 'small', onclick: () => { if (confirm(`Cancel “${r.name}”? ${r.settled ? 'What was already settled stays in the balances; the rest' : 'It'} will no longer be expected.`)) act(`/api/${out ? 'payments' : 'receipts'}/${r.id}/cancel`, {}); } }, 'Cancel')]));
    }))));
}

function txDialog(kind, accounts) {
  const out = kind === 'OUT';
  if (!accounts.length) return alert('Add a bank account first (Bank position → “+ Account”).');
  openDialog(out ? 'Record a payment' : 'Record a receipt', [
    { name: out ? 'payee' : 'party', label: out ? 'Paid to' : 'Received from', required: true },
    { name: 'amount', label: 'Amount (₹)', type: 'money', required: true },
    { name: 'status', label: 'Status', type: 'select', value: 'completed', options: [['completed', out ? 'Paid — the money has left the bank' : 'Received — the money is in the bank'], ['pending', out ? 'Pending — still to pay (balances not affected)' : 'Pending — still to come (balances not affected)']] },
    { name: 'date', label: 'Date', type: 'date', value: S.today, required: true, hint: 'For a received / paid item, the date it went through the bank (today or earlier). For a pending one, the date it is due.' },
    { name: 'bank_id', label: 'Bank account', type: 'select', options: [...accounts.map((b) => [b.id, `${b.name} — ${b.bank} XXXX${b.last4}`]), ['', 'Not decided yet (pending only)']], required: false },
    { name: 'bank_ref', label: 'Bank reference (UTR / cheque no.)', hint: 'Needed when it is received or paid. The same reference can’t be used twice on one account.' },
    ...(out ? [{ name: 'category', label: 'Category', type: 'select', options: CATEGORIES.map((c) => [c, c]), required: true }] : []),
    { name: 'ref', label: out ? 'Invoice / bill no. (optional)' : 'Invoice no. (optional)' },
    { name: 'note', label: 'Description (optional)' },
    ...(out && can('admin') ? [{ name: 'approved', label: 'Approved', type: 'checkbox', value: true }] : []),
  ], out ? 'Record payment' : 'Record receipt', (v) => confirmDup((dup) => api('/api/transactions', { ...v, kind, confirmDuplicate: dup })));
}

// one alert per account that can't cover its EMIs in the next 30 days: the first one it misses, and the total it needs
function shortfallAlerts(list) {
  const byBank = new Map();
  for (const x of list) byBank.set(x.bank_id, [...(byBank.get(x.bank_id) ?? []), x]);
  return [...byBank.values()].map((xs) => {
    const first = xs[0], all = xs.at(-1);
    return xs.length === 1
      ? `${first.bank_name} can’t cover the ${first.lender} EMI of ${inr(first.left)} due ${nice(first.due_date)} — short by ${inr(first.short_by)}. Move money in before then.`
      : `${first.bank_name} can’t cover ${xs.length} EMIs due in the next 30 days. The first is the ${first.lender} EMI of ${inr(first.left)} on ${nice(first.due_date)} (short by ${inr(first.short_by)}); to cover them all it needs ${inr(all.short_by)} more by ${nice(all.due_date)}.`;
  });
}

// ── dashboard summary cards ──
function summaryCards(d) {
  if (!d) return null;
  const card = (tone, ic, label, amount, sub, target) => h(target ? 'button' : 'div', { class: `sum-card ${tone}`, onclick: target ? () => go(target) : null },
    h('span', { class: 'sum-ic' }, icon(ic)), h('span', { class: 'sum-lbl' }, label), h('strong', { class: `sum-amt ${amount < 0 ? 'neg' : ''}` }, inr(amount)), h('span', { class: 'sum-sub' }, sub));
  const n = (x) => `${x.count} EMI${x.count === 1 ? '' : 's'}`;
  return h('section', { class: 'sum-cards', 'aria-label': 'Summary' },
    card('k-blue', 'wallet', 'Total bank balance', d.balance, 'All accounts, now'),
    card('k-amber', 'lock', 'Reserved for EMIs', d.reserved, 'Set aside in this app', 'emis'),
    card(d.available < 0 ? 'k-red' : 'k-green', 'check', 'Available balance', d.available, 'Balance − reserved'),
    card('k-violet', 'clock', 'EMIs next 7 days', d.next7.amount, n(d.next7), 'emis'),
    card('k-violet', 'calendar', 'EMIs next 30 days', d.next30.amount, n(d.next30), 'emis'),
    card(d.overdue.count ? 'k-red' : 'k-plain', 'alert', 'Overdue EMIs', d.overdue.amount, d.overdue.count ? n(d.overdue) : 'None', 'emis'),
    card('k-green', 'down', 'Receipts this month', d.received, `Received since ${nice(d.from)}`, 'transactions:history'),
    card('k-red', 'up', 'Payments this month', d.paid, `Paid since ${nice(d.from)}`, 'transactions:history'));
}

// ── EMI management: loans, the money reserved for them, the schedule, and reminders ──
const EMI_STATE = { overdue: ['Overdue', 'c-red'], due: ['Due today', 'c-amber'], upcoming: ['Upcoming', 'c-blue'], scheduled: ['Scheduled', ''], paid: ['Paid', 'c-green'], cancelled: ['Cancelled', ''] };
const HOLD_OPTS = [['0', 'The EMI day'], ['1', '1 day before'], ['2', '2 days before'], ['3', '3 days before'], ['5', '5 days before'], ['7', '7 days before'], ['10', '10 days before'], ['15', '15 days before']];

async function loadEmis() {
  if (!S.ef) S.ef = { status: 'open', emi: '', bank: '' };
  const qs = new URLSearchParams(Object.entries(S.ef).filter(([, v]) => v));
  const [ov, list, sched, rem] = await Promise.all([api('/api/emis/overview'), api('/api/emis'), api(`/api/emis/schedule?${qs}`), can('admin') ? api('/api/reminders/status') : null]);
  renderEmis(ov, list.emis, sched.rows, rem);
}

function renderEmis(ov, emis, rows, rem) {
  const T = ov.totals, f = S.ef;
  const bankOpts = ov.accounts.map((b) => [b.id, `${b.name} — ${b.bank}`]);
  const tile = (cls, label, p, sub) => h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-lbl' }, label), h('div', { class: `tile-amt ${p < 0 ? 'neg' : ''}` }, inr(p)), sub && h('div', { class: 'tile-sub' }, sub));
  const summary = h('header', { class: 'hero' },
    h('div', { class: 'hero-top' }, h('div', {}, h('div', { class: 'eyebrow' }, `Today · ${nice(ov.today)}`), h('h1', {}, 'EMIs at a glance'))),
    h('div', { class: 'tiles' },
      tile('t-hold', 'Reserved for EMIs', T.reserved, 'Set aside in this app — not frozen at the bank'),
      tile(T.available < 0 ? 't-fin bad' : 't-fin', 'Available to spend', T.available, `Balance ${inr(T.balance)} − reserved`),
      tile('t-pay', `Overdue (${T.overdue.count})`, T.overdue.amount, T.overdue.count ? 'Unpaid after the due date' : 'Nothing overdue'),
      tile('t-bal', `Due in 30 days (${T.due.count + T.upcoming.count})`, T.due.amount + T.upcoming.amount, `${T.active} active EMI(s) · ${inr(T.monthly)} a month`)));

  const accounts = ov.accounts.length > 0 && h('div', { class: 'bank-cards' }, ov.accounts.map((a) => h('section', { class: `bank-card ${a.available < 0 ? 'short' : ''}` },
    h('div', { class: 'bc-head' }, h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted small' }, a.bank)),
      a.available < 0 ? h('span', { class: 'chip c-red' }, `short by ${inr(-a.available)}`) : a.reserved > 0 ? h('span', { class: 'chip c-amber' }, 'reserved') : null),
    h('div', { class: `bc-amt ${a.available < 0 ? 'neg' : ''}` }, inr(a.available)),
    h('div', { class: 'muted small bc-cap' }, 'available to spend'),
    h('div', { class: 'bc-line' }, h('span', { class: 'muted' }, 'Balance now'), money(a.balance)),
    h('div', { class: 'bc-line' }, h('span', { class: 'muted' }, '− Reserved for EMIs'), money(a.reserved, 'amber')),
    h('div', { class: 'bc-line total' }, h('span', {}, '= Available'), money(a.available)),
    h('div', { class: 'muted small bc-next' }, a.next ? `Next: ${a.next.lender} ${inr(a.next.left)} on ${nice(a.next.due_date)}` : 'No EMIs due from this account'),
    !a.balanceEntered && h('div', { class: 'muted small' }, 'No bank balance entered yet.'))));

  const loans = h('section', { class: 'card' },
    h('h2', {}, h('span', { class: 'dot d-amber' }), 'Loans', h('span', { class: 'count' }, emis.filter((e) => e.active).length)),
    emis.length ? h('div', { class: 'scroll' }, h('table', { class: 'tx' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Loan'), h('th', {}, 'Account'), h('th', { class: 'num' }, 'EMI'), h('th', {}, 'Every month'), h('th', {}, 'Reserved from'), h('th', {}, 'Reminders'), h('th', {}, 'Next due'), h('th', {}, 'Status'), can('editor') && h('th', {}, ''))),
      h('tbody', {}, emis.map((e) => h('tr', { class: e.active ? '' : 'inactive' },
        h('td', {}, h('strong', {}, e.lender), e.ref && h('div', { class: 'muted small' }, e.ref)),
        h('td', {}, e.bank_name),
        h('td', { class: 'num' }, money(e.amount, 'amber')),
        h('td', { class: 'nowrap' }, `Day ${e.day}`, e.end_date && h('div', { class: 'muted small' }, `until ${nice(e.end_date)}`)),
        h('td', {}, e.hold_days ? `${e.hold_days} day(s) before` : 'On the EMI day'),
        h('td', {}, h('div', { class: 'chips' },
          e.remind_in_app ? h('span', { class: 'chip c-blue' }, `In-app · ${remindSummary(e)}`) : null,
          e.remind_email ? h('span', { class: 'chip c-violet', title: e.remind_to || 'All admins' }, `Email · ${e.remind_to ? e.remind_to.split(', ').length + ' address(es)' : 'admins'}`) : null,
          !e.remind_in_app && !e.remind_email && h('span', { class: 'muted small' }, 'Off'))),
        h('td', { class: 'nowrap' }, e.next_due ? nice(e.next_due) : '—'),
        h('td', {}, h('span', { class: `chip ${e.active ? 'c-green' : ''}` }, e.active ? 'Active' : 'Stopped')),
        can('editor') && h('td', { class: 'acts-cell' }, e.active && [
          h('button', { class: 'small', onclick: () => emiSettingsDialog(e) }, 'Settings'),
          h('button', { class: 'small', onclick: () => { if (confirm(`Stop the EMI “${e.lender}”? Instalments after today that have nothing paid will be removed.`)) act(`/api/emis/${e.id}/stop`, {}); } }, 'Stop')]))))))
      : h('p', { class: 'empty' }, can('editor') ? 'No EMIs yet. Add your loans with “+ Add EMI”.' : 'No EMIs yet.'));

  const set = (k) => (e) => { S.ef = { ...S.ef, [k]: e.target.value }; load(); };
  const schedule = h('section', { class: 'card' },
    h('div', { class: 'toolbar-row' },
      h('h2', {}, h('span', { class: 'dot d-blue' }), 'Schedule', h('span', { class: 'count' }, rows.length)),
      h('div', { class: 'bar' },
        h('select', { 'aria-label': 'Schedule status', onchange: set('status') }, [['open', 'Still to pay'], ['overdue', 'Overdue'], ['due', 'Due today'], ['upcoming', 'Next 30 days'], ['scheduled', 'Later'], ['paid', 'Paid'], ['cancelled', 'Cancelled'], ['', 'Everything (incl. next 12 months)']].map(([v, t]) => h('option', { value: v, selected: f.status === v }, t))),
        h('select', { 'aria-label': 'Loan', onchange: set('emi') }, [['', 'All loans'], ...emis.map((e) => [String(e.id), e.lender + (e.active ? '' : ' (stopped)')])].map(([v, t]) => h('option', { value: v, selected: f.emi === v }, t))),
        h('select', { 'aria-label': 'Account', onchange: set('bank') }, [['', 'All accounts'], ...ov.accounts.map((a) => [String(a.id), a.name])].map(([v, t]) => h('option', { value: v, selected: f.bank === v }, t))))),
    rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'tx' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Due date'), h('th', {}, 'Loan'), h('th', {}, 'Account'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Paid'), h('th', {}, 'Status'), can('editor') && h('th', {}, ''))),
      h('tbody', {}, rows.map((r) => {
        const [label, tone] = EMI_STATE[r.state], open = !r.projected && r.left > 0 && r.state !== 'cancelled';
        return h('tr', { class: r.state === 'cancelled' ? 'inactive' : '' },
          h('td', { class: 'nowrap' }, nice(r.due_date)),
          h('td', {}, h('strong', {}, r.lender), r.loan_ref && h('div', { class: 'muted small' }, r.loan_ref)),
          h('td', {}, r.bank_name),
          h('td', { class: 'num' }, money(r.amount)),
          h('td', { class: 'num' }, r.paid ? money(r.paid, 'pos') : '—', r.refs && h('div', { class: 'muted small' }, r.refs)),
          h('td', {}, h('div', { class: 'chips' }, h('span', { class: `chip ${tone}` }, label), r.paid > 0 && r.left > 0 && h('span', { class: 'chip c-blue' }, `${inr(r.left)} left`),
            r.reserved && h('span', { class: 'chip c-amber', title: `Reserved in this app since ${nice(r.hold_from)}` }, 'reserved'),
            r.covered === false && h('span', { class: 'chip c-red', title: 'The account’s balance can’t pay this together with its earlier EMIs.' }, `not covered · short ${inr(r.short_by)}`), r.projected && h('span', { class: 'muted small' }, 'projected'))),
          can('editor') && h('td', { class: 'acts-cell' }, open && h('button', { class: 'small solid-red', onclick: () => settleDialog({ kind: 'OUT', id: r.payment_id, name: `${r.lender} EMI (${nice(r.due_date)})`, amount: r.left, bankId: r.bank_id }, bankOpts) }, 'Confirm payment')));
      }))))
      : h('p', { class: 'empty' }, 'Nothing matches.'));

  const reminders = rem && h('section', { class: 'card' },
    h('h2', {}, h('span', { class: 'dot d-violet' }), 'Email reminders'),
    h('div', { class: 'chips' },
      h('span', { class: `chip ${rem.emailConfigured ? 'c-green' : 'c-amber'}` }, rem.emailConfigured ? 'Email sending is set up' : 'Email sending is not set up'),
      h('span', { class: `chip ${rem.scheduleConfigured ? 'c-green' : 'c-amber'}` }, rem.scheduleConfigured ? 'Daily check is set up' : 'Daily check is not set up')),
    (!rem.emailConfigured || !rem.scheduleConfigured) && h('p', { class: 'muted small' },
      !rem.emailConfigured && 'To send emails, add RESEND_API_KEY and EMAIL_FROM to the server’s settings. ',
      !rem.scheduleConfigured && 'For a check every morning even when nobody opens the app, add CRON_SECRET. Until then, reminders are checked whenever someone uses the app or presses “Check reminders now”.'),
    rem.outbox.length ? h('div', { class: 'scroll' }, h('table', { class: 'tx' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Queued'), h('th', {}, 'To'), h('th', {}, 'Subject'), h('th', {}, 'Status'))),
      h('tbody', {}, rem.outbox.map((m) => h('tr', {},
        h('td', { class: 'nowrap' }, when(m.created_at)), h('td', {}, m.to_addr), h('td', {}, m.subject),
        h('td', {}, h('span', { class: `chip ${{ sent: 'c-green', failed: 'c-red', skipped: 'c-amber', pending: 'c-blue' }[m.status]}`, title: m.error }, m.status), m.error && h('div', { class: 'muted small' }, m.error)))))))
      : h('p', { class: 'empty' }, 'No email reminders yet.'));

  app.replaceChildren(...[topBar(),
    pageHead('EMI management', 'Monthly loan instalments, the money reserved for them in this app, and reminders.',
      can('admin') && h('button', { onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await api('/api/reminders/run', {}); alert(`${r.reminders} reminder(s) due: ${r.inApp} new in-app, ${r.queued} email(s) queued, ${r.sent} sent${r.skipped ? `, ${r.skipped} not sent (email not set up)` : ''}${r.failed ? `, ${r.failed} failed` : ''}.`); S.notesAt = 0; await load(); }
        catch (x) { alert(x.message); e.target.disabled = false; }
      } }, 'Check reminders now'),
      can('editor') && h('button', { class: 'primary', onclick: () => emiForm(bankOpts) }, '+ Add EMI')),
    summary, accounts, loans, schedule, reminders].filter(Boolean));
}

// "7, 3, 1 days before · due · overdue"
const remindSummary = (e) => [e.remind_before?.length ? `${e.remind_before.join('/')}d before` : '', e.remind_due && 'due', e.remind_overdue && 'overdue'].filter(Boolean).join(' · ') || 'off';
// the reminder points offered: 7, 3 and 1 days, plus any other point an EMI already has
const pointsFor = (e) => [...new Set([7, 3, 1, ...(e?.remind_before ?? [])])].sort((a, b) => b - a);
const reminderFields = (e) => [
  { name: 'hold_days', label: 'Reserve the money from', type: 'select', value: String(e?.hold_days ?? 0), options: HOLD_OPTS,
    hint: 'A reservation inside this app: the app won’t let reserved money be paid to anyone else from this account. Your bank isn’t asked to hold it.' },
  ...pointsFor(e).map((d) => ({ name: `before_${d}`, label: `Remind ${d} day${d === 1 ? '' : 's'} before`, type: 'checkbox', value: e ? e.remind_before.includes(d) : true })),
  { name: 'remind_due', label: 'Remind on the due date', type: 'checkbox', value: e?.remind_due ?? true },
  { name: 'remind_overdue', label: 'Remind if it becomes overdue', type: 'checkbox', value: e?.remind_overdue ?? true },
  { name: 'remind_in_app', label: 'In-app reminder (the bell)', type: 'checkbox', value: e?.remind_in_app ?? true },
  { name: 'remind_email', label: 'Email reminder', type: 'checkbox', value: e?.remind_email ?? false },
  { name: 'remind_to', label: 'Email to (optional)', value: e?.remind_to ?? '', placeholder: 'accounts@firm.in, owner@firm.in', hint: 'Leave blank to email all admins. Up to 5 addresses.' },
];

const reminderBody = (v) => {
  const out = { ...v, remind_before: [] };
  for (const k of Object.keys(v)) if (k.startsWith('before_')) { if (v[k]) out.remind_before.push(Number(k.slice(7))); delete out[k]; }
  return out;
};

function emiForm(bankOpts) {
  if (!bankOpts.length) return alert('Add a bank account first (Dashboard → “+ Account”).');
  openDialog('Add an EMI', [
    { name: 'lender', label: 'Lender / loan', placeholder: 'e.g. HDFC car loan', required: true },
    { name: 'amount', label: 'EMI amount (₹)', type: 'money', required: true },
    { name: 'bank_id', label: 'Paid from account', type: 'select', options: bankOpts, required: true },
    { name: 'start_date', label: 'Next EMI date', type: 'date', min: addDays(S.today, -31), required: true, hint: 'It repeats on this day every month (the last day in shorter months).' },
    { name: 'end_date', label: 'Last EMI date (optional)', type: 'date' },
    { name: 'ref', label: 'Loan account no. (optional)' },
    ...reminderFields(null),
  ], 'Add EMI', (v) => confirmDup((dup) => api('/api/emis', { ...reminderBody(v), confirmDuplicate: dup })), null, true);
}

function emiSettingsDialog(e) {
  openDialog(`Settings: ${e.lender}`, reminderFields(e), 'Save', (v) => api(`/api/emis/${e.id}`, reminderBody(v)), `${inr(e.amount)} from ${e.bank_name}, every month on day ${e.day}.`);
}

// ── People ──
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const pageHead = (title, sub, ...actions) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub && h('div', { class: 'muted' }, sub)), h('div', { class: 'bar' }, actions));
const statusChip = (active) => h('span', { class: `chip ${active ? 'c-green' : ''}` }, active ? 'Active' : 'Inactive');
// keep the cursor in a search box when its page re-renders
const keepFocus = (render) => {
  const a = document.activeElement, name = a?.name, pos = a?.selectionStart;
  render();
  const n = name && app.querySelector(`input[name="${name}"]`);
  if (n && a?.tagName === 'INPUT' && a.type === 'search') { n.focus(); n.setSelectionRange(pos, pos); }
};
let searchTimer;
const onSearch = (apply) => (e) => { clearTimeout(searchTimer); const v = e.target.value; searchTimer = setTimeout(() => { apply(v); load(); }, 250); };

async function loadPeople() {
  const p = new URLSearchParams(S.pf);
  const [{ people, contactsHidden }, { positions }] = await Promise.all([api(`/api/people?${p}`), api('/api/positions')]);
  keepFocus(() => renderPeople(people, positions, contactsHidden));
}

function renderPeople(people, positions, hidden) {
  const filters = h('div', { class: 'card toolbar' },
    h('div', { class: 'bar grow' },
      h('input', { type: 'search', name: 'q', class: 'search', placeholder: hidden ? 'Search name or position' : 'Search name, email, phone or position', value: S.pf.q, oninput: onSearch((v) => { S.pf.q = v; }), 'aria-label': 'Search people' }),
      h('select', { 'aria-label': 'Status', onchange: (e) => { S.pf.status = e.target.value; load(); } },
        [['active', 'Active'], ['inactive', 'Inactive'], ['all', 'Everyone']].map(([v, t]) => h('option', { value: v, selected: S.pf.status === v }, t))),
      h('select', { 'aria-label': 'Position', onchange: (e) => { S.pf.position = e.target.value; load(); } },
        [['', 'All positions'], ['none', 'No position'], ...positions.map((x) => [String(x.id), x.name + (x.active ? '' : ' (inactive)')])].map(([v, t]) => h('option', { value: v, selected: S.pf.position === v }, t)))));
  const table = people.length
    ? h('div', { class: 'scroll' }, h('table', { class: 'people' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Position'), !hidden && h('th', {}, 'Email'), !hidden && h('th', {}, 'Phone'), h('th', {}, 'Status'), can('editor') && h('th', {}, ''))),
      h('tbody', {}, people.map((x) => h('tr', { class: x.active ? '' : 'inactive' },
        h('td', {}, h('button', { class: 'link', onclick: () => personView(x, positions, hidden) }, x.name)),
        h('td', {}, x.position ? h('span', { class: `chip ${x.position_active ? 'c-violet' : ''}` }, x.position) : h('span', { class: 'muted' }, '—')),
        !hidden && h('td', {}, x.email || h('span', { class: 'muted' }, '—')),
        !hidden && h('td', { class: 'nowrap' }, x.phone || h('span', { class: 'muted' }, '—')),
        h('td', {}, statusChip(x.active)),
        can('editor') && h('td', { class: 'acts-cell' },
          h('button', { class: 'small', onclick: () => personForm(x, positions) }, 'Edit'),
          h('button', { class: 'small', onclick: () => setPersonActive(x, !x.active) }, x.active ? 'Deactivate' : 'Activate')))))))
    : h('p', { class: 'empty' }, S.pf.q || S.pf.position || S.pf.status !== 'active' ? 'No one matches.' : 'No people yet.');
  app.replaceChildren(topBar(),
    pageHead('People', `${people.length} shown${hidden ? ' · contact details are visible to editors and admins' : ''}`,
      can('editor') && h('button', { class: 'primary', onclick: () => personForm(null, positions) }, '+ Person')),
    filters, h('section', { class: 'card' }, table));
}

function personView(x, positions, hidden) {
  const row = (k, v) => v !== undefined && h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v || '—'));
  dlg.className = '';
  dlg.replaceChildren(h('h2', {}, x.name, ' ', statusChip(x.active)),
    h('div', { class: 'kvs' },
      row('Position', x.position ? `${x.position}${x.position_active ? '' : ' (inactive position)'}` : ''),
      !hidden && row('Email', x.email), !hidden && row('Phone', x.phone), !hidden && row('Notes', x.notes),
      row('Added', `${when(x.created_at)}${x.created_by ? ` by ${x.created_by}` : ''}`),
      row('Last changed', `${when(x.updated_at)}${x.updated_by ? ` by ${x.updated_by}` : ''}`)),
    h('div', { class: 'bar' },
      can('editor') && h('button', { class: 'primary', onclick: () => personForm(x, positions) }, 'Edit'),
      h('button', { onclick: () => dlg.close() }, 'Close')));
  dlg.showModal();
}

function personForm(x, positions) {
  // a person keeps an inactive position until it is changed; new choices are active positions only
  const opts = [['', 'No position'], ...positions.filter((p) => p.active || p.id === x?.position_id).map((p) => [p.id, p.name + (p.active ? '' : ' (inactive)')])];
  openDialog(x ? `Edit ${x.name}` : 'Add a person', [
    { name: 'name', label: 'Full name', value: x?.name, required: true },
    { name: 'position_id', label: 'Position', type: 'select', value: x?.position_id ?? '', options: opts, hint: positions.length ? null : 'No positions yet — an admin adds them under Positions.' },
    { name: 'email', label: 'Email (optional)', type: 'email', value: x?.email },
    { name: 'phone', label: 'Phone (optional)', type: 'tel', value: x?.phone, placeholder: '+91 98765 43210' },
    { name: 'notes', label: 'Notes (optional)', value: x?.notes },
  ], x ? 'Save changes' : 'Add person', (v) => api(x ? `/api/people/${x.id}` : '/api/people', v));
}

const setPersonActive = (x, active) => {
  if (!active && !confirm(`Deactivate ${x.name}? They stay on record and can be activated again.`)) return;
  act(`/api/people/${x.id}/active`, { active });
};

// ── Positions ──
async function loadPositions() {
  const [{ positions }, people] = await Promise.all([api('/api/positions'), can('editor') ? api('/api/people?status=active') : null]);
  renderPositions(positions, people?.people ?? []);
}

function renderPositions(positions, people) {
  const list = positions.length
    ? positions.map((p) => h('div', { class: `pos-row ${p.active ? '' : 'inactive'}` },
      h('div', { class: 'item-main' },
        h('div', {}, h('strong', {}, p.name), ' ', statusChip(p.active)),
        p.description && h('div', { class: 'muted small' }, p.description),
        h('div', { class: 'muted small' }, `${p.people} active ${p.people === 1 ? 'person' : 'people'}`)),
      h('div', { class: 'acts' },
        can('editor') && p.active && h('button', { class: 'small c-violet', onclick: () => assignDialog(p, people) }, 'Assign'),
        h('button', { class: 'small', onclick: () => { S.view = 'people'; S.pf = { status: 'active', position: String(p.id), q: '' }; load(); } }, 'View people'),
        can('admin') && h('button', { class: 'small', onclick: () => positionForm(p) }, 'Edit'),
        can('admin') && h('button', { class: 'small', onclick: () => setPositionActive(p, !p.active) }, p.active ? 'Deactivate' : 'Activate'))))
    : h('p', { class: 'empty' }, can('admin') ? 'No positions yet. Add the ones your team uses, e.g. Accountant, Manager, Director.' : 'No positions yet — an admin adds them.');
  app.replaceChildren(topBar(),
    pageHead('Positions', can('admin') ? 'Create the positions your team uses and assign them to people.' : 'The positions people can hold.',
      can('admin') && h('button', { class: 'primary', onclick: () => positionForm(null) }, '+ Position')),
    h('section', { class: 'card' }, list));
}

function positionForm(p) {
  openDialog(p ? `Edit ${p.name}` : 'Add a position', [
    { name: 'name', label: 'Position name', value: p?.name, placeholder: 'e.g. Accountant', required: true },
    { name: 'description', label: 'Description (optional)', value: p?.description },
  ], p ? 'Save changes' : 'Add position', (v) => api(p ? `/api/positions/${p.id}` : '/api/positions', v));
}

const setPositionActive = (p, active) => {
  if (!active && !confirm(`Deactivate “${p.name}”? People keep it, but it can’t be given to anyone new until it is activated again.`)) return;
  act(`/api/positions/${p.id}`, { active });
};

function assignDialog(p, people) {
  const others = people.filter((x) => x.position_id !== p.id);
  if (!others.length) return alert(people.length ? `Everyone active already holds “${p.name}”.` : 'There are no active people yet. Add them under People.');
  openDialog(`Assign “${p.name}”`, [
    { name: 'person_id', label: 'Person', type: 'select', options: others.map((x) => [x.id, x.name + (x.position ? ` — now ${x.position}` : '')]), required: true },
  ], 'Assign', (v) => api(`/api/positions/${p.id}/assign`, v), 'Their current position, if any, is replaced.');
}

// ── Activity log (admins) ──
const ACTION_LABELS = {
  'emi.edit': 'Changed EMI settings', 'emi.reminders': 'Checked EMI reminders',
  'report.export': 'Exported a report',
  login: 'Signed in', 'login.failed': 'Failed sign-in', 'login.locked': 'Locked out (too many wrong passwords)', logout: 'Signed out',
  setup: 'Set up the app (first admin)', 'admin.create': 'Admin account created (script)', 'user.add': 'Added a user',
  'person.add': 'Added a person', 'person.edit': 'Edited a person', 'person.activate': 'Activated a person', 'person.deactivate': 'Deactivated a person', 'person.assign': 'Assigned a position',
  'position.add': 'Added a position', 'position.edit': 'Edited a position', 'position.activate': 'Activated a position', 'position.deactivate': 'Deactivated a position',
  'payment.add': 'Added a payment', 'payment.paid': 'Marked a payment paid', 'payment.approve': 'Approved a payment', 'payment.cancel': 'Cancelled a payment',
  'receipt.add': 'Added a receipt', 'receipt.received': 'Marked a receipt received', 'receipt.cancel': 'Cancelled a receipt',
  'emi.add': 'Added an EMI', 'emi.stop': 'Stopped an EMI', 'balance.add': 'Entered a bank balance', 'bank.add': 'Added a bank account',
};
const actionTone = (a) => (/failed|locked/.test(a) ? 'c-red' : /^(login|logout|setup|admin)/.test(a) ? 'c-blue' : /^(person|position|user)/.test(a) ? 'c-violet' : /cancel|deactivate|stop/.test(a) ? 'c-red' : 'c-amber');
// a short, readable summary of what was recorded
function describe(a, positions) {
  const d = a.detail || {}, out = [];
  const fmt = (k, v) => (v == null || v === '' ? '—' : k === 'position_id' ? positions.get(v) ?? `#${v}` : /amount/i.test(k) && typeof v === 'number' ? inr(v) : String(v));
  if (a.action === 'emi.reminders') return `${d.reminders ?? 0} due · ${d.inApp ?? 0} in-app · ${d.queued ?? 0} email(s) queued · ${d.sent ?? 0} sent${d.via ? ' · daily schedule' : ''}`;
  if (a.action === 'report.export') return `${String(d.format).toUpperCase()} · ${d.view === 'history' ? 'transaction history' : 'receipts & payments'} · ${d.from} to ${d.to} · ${d.rows} row(s)`;
  for (const k of ['name', 'payee', 'party', 'lender', 'email', 'role', 'reason']) if (d[k]) out.push(String(d[k]));
  if (d.amount != null && typeof d.amount === 'number') out.push(inr(d.amount));
  for (const k of ['date', 'asOf', 'ref']) if (d[k]) out.push(String(d[k]));
  if (d.changes) out.push(Object.entries(d.changes).map(([k, [b, n]]) => `${k.replace('_id', '')}: ${fmt(k, b)} → ${fmt(k, n)}`).join(', '));
  if (d.position_id && !d.changes) out.push(`position: ${fmt('position_id', d.position_id)}`);
  return out.join(' · ');
}

async function loadActivity(more = false) {
  const p = new URLSearchParams(Object.entries(S.af).filter(([, v]) => v));
  if (more && S.act?.rows.length) p.set('before', S.act.rows.at(-1).id);
  const [{ activity, more: hasMore }, users, positions] = await Promise.all([
    api(`/api/activity?${p}`), more ? S.act.users : api('/api/users').then((x) => x.users), more ? S.act.positions : api('/api/positions').then((x) => new Map(x.positions.map((y) => [y.id, y.name]))),
  ]);
  S.act = { rows: more ? [...S.act.rows, ...activity] : activity, more: hasMore, users, positions };
  keepFocus(renderActivity);
}

function renderActivity() {
  const { rows, more, users, positions } = S.act, f = S.af;
  const set = (k) => (e) => { S.af = { ...S.af, [k]: e.target.value }; load(); };
  const filters = h('div', { class: 'card toolbar' }, h('div', { class: 'bar grow' },
    h('input', { type: 'search', name: 'aq', class: 'search', placeholder: 'Search actions, names, references', value: f.q ?? '', oninput: onSearch((v) => { S.af = { ...S.af, q: v }; }), 'aria-label': 'Search activity' }),
    h('select', { 'aria-label': 'Who', onchange: set('user') }, [['', 'Everyone'], ...users.map((u) => [String(u.id), `${u.name} (${u.role})`]), ['none', 'Not signed in']].map(([v, t]) => h('option', { value: v, selected: (f.user ?? '') === v }, t))),
    h('select', { 'aria-label': 'Type', onchange: set('type') }, [['', 'All activity'], ['signin', 'Sign-ins'], ['people', 'People'], ['positions', 'Positions'], ['payments', 'Payments'], ['receipts', 'Receipts'], ['emis', 'EMIs'], ['balances', 'Bank balances'], ['accounts', 'Bank accounts'], ['users', 'Users'], ['reports', 'Report exports']]
      .map(([v, t]) => h('option', { value: v, selected: (f.type ?? '') === v }, t))),
    h('label', { class: 'check' }, 'From', h('input', { type: 'date', value: f.from ?? '', max: S.today, onchange: set('from') })),
    h('label', { class: 'check' }, 'To', h('input', { type: 'date', value: f.to ?? '', max: S.today, onchange: set('to') })),
    Object.values(f).some(Boolean) && h('button', { class: 'small', onclick: () => { S.af = {}; load(); } }, 'Clear')));
  const table = rows.length
    ? h('div', { class: 'scroll' }, h('table', { class: 'activity' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When (IST)'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Details'))),
      h('tbody', {}, rows.map((a) => h('tr', {},
        h('td', { class: 'nowrap' }, when(a.at)),
        h('td', {}, a.user_name ? h('span', {}, a.user_name, h('div', { class: 'muted small' }, a.user_role)) : h('span', { class: 'muted' }, 'Not signed in')),
        h('td', {}, h('span', { class: `chip ${actionTone(a.action)}` }, ACTION_LABELS[a.action] ?? a.action)),
        h('td', { class: 'small' }, describe(a, positions)))))))
    : h('p', { class: 'empty' }, 'Nothing matches.');
  app.replaceChildren(topBar(),
    pageHead('Activity log', 'Everything people do in the app: sign-ins (including failed ones), changes, approvals and cancellations — who did it and when.'),
    filters, h('section', { class: 'card' }, table,
      more && h('div', { class: 'more' }, h('button', { onclick: () => loadActivity(true).catch((e) => alert(e.message)) }, 'Load older activity'))));
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
