// The screen: sign-in, and the day's position — bank balance − payments due + receipts expected.
// Amounts arrive from the server in paise and are typed in as rupees.

const app = document.getElementById('app'), dlg = document.getElementById('dlg');
const S = { user: null, today: '', date: '', approvedOnly: false, uncertain: true, pos: null };
// what one signed-in person was looking at; cleared on sign-out so the next person starts fresh
const fresh = () => Object.assign(S, { rec: null, bday: null, view: 'position', af: {}, act: null, tf: null, ef: null, dash: null, notes: null, notesAt: 0, approvedOnly: false, uncertain: true });
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
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Something went wrong.'), { code: j.error?.code, detail: j.error?.detail });
  return j;
}

// ── choosing a bank account by typing: a search box in place of a drop-down ──
// Shows the account chosen; clicking it lists them all (like a drop-down), typing narrows the list by name, bank or
// last 4 digits ("hdfc", "1111", "salary"). Arrow keys and Enter choose, Escape puts back what was there.
// options: [[value, text]] ('' may be a choice too, e.g. "Not decided yet"). The element's .value is the chosen value,
// so a form reads it like a <select>; onchange(value) is called when the choice changes.
let pickers = 0;
function bankPicker({ options, value = '', name, label, required, placeholder = 'Type to search accounts…', onchange }) {
  const id = `bank-pick-${++pickers}`, opts = options.map(([v, t]) => ({ v: String(v), t: String(t) }));
  let chosen = opts.find((o) => o.v === String(value ?? '')) ?? (required ? null : opts.find((o) => o.v === '')) ?? null;
  let shown = [], active = -1;
  const input = h('input', { type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label,
    autocomplete: 'off', spellcheck: 'false', placeholder, required, class: 'bank-pick-input' });
  const list = h('ul', { id, role: 'listbox', class: 'bank-pick-list', hidden: true });
  const el = h('div', { class: 'bank-pick', 'data-name': name ?? null }, input, list);
  const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const matches = (o, q) => words(q).every((w) => words(o.t).some((x) => x.startsWith(w)) || o.t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(w));
  const show = (q = '') => {
    shown = q ? opts.filter((o) => matches(o, q)) : opts;
    active = shown.indexOf(chosen) >= 0 && !q ? shown.indexOf(chosen) : shown.length ? 0 : -1;
    list.replaceChildren(...(shown.length ? shown.map((o, i) => h('li', { id: `${id}-${i}`, role: 'option', 'aria-selected': String(i === active), class: [i === active && 'active', o === chosen && 'chosen'].filter(Boolean).join(' '),
      onmousedown: (e) => { e.preventDefault(); pick(o); } }, o.t)) : [h('li', { class: 'none' }, `No account matches “${q}”`)]));
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (active >= 0) { input.setAttribute('aria-activedescendant', `${id}-${active}`); list.children[active].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const sync = () => { input.value = chosen ? chosen.t : ''; input.setCustomValidity(''); };
  const pick = (o) => { const was = chosen; chosen = o; sync(); close(); if (o !== was) onchange?.(o.v); };
  list.addEventListener('click', (e) => e.preventDefault()); // in a form the picker sits in a <label>: its click would reopen the list
  input.addEventListener('focus', () => { input.select(); show(); });
  input.addEventListener('click', () => { if (list.hidden) show(); });
  input.addEventListener('input', () => { show(input.value.trim()); input.setCustomValidity(required && !input.value.trim() ? '' : 'Choose an account from the list.'); });
  input.addEventListener('blur', () => { close(); sync(); }); // typed but not chosen: back to what was chosen
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return show();
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      [...list.children].forEach((li, i) => { li.classList.toggle('active', i === active); li.setAttribute('aria-selected', String(i === active)); });
      input.setAttribute('aria-activedescendant', `${id}-${active}`); list.children[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !list.hidden) { e.preventDefault(); if (shown[active]) pick(shown[active]); } // choosing doesn't send the form
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); sync(); input.select(); } // (the dialog stays open)
    else if (e.key === 'Tab' && !list.hidden && input.value.trim() && shown[active] && input.value !== chosen?.t) pick(shown[active]);
  });
  Object.defineProperty(el, 'value', { get: () => chosen?.v ?? '', set: (v) => { chosen = opts.find((o) => o.v === String(v)) ?? null; sync(); } });
  el.focus = () => input.focus();
  sync();
  return el;
}

// fields: [{ name, label, type, value, options: [[value, text]], hint, required, min, max }] — type 'bank': a bankPicker
function form(fields, submitLabel, onSubmit, { onCancel } = {}) {
  const err = h('p', { class: 'err', role: 'alert' });
  const inputs = {};
  const rows = fields.map((f) => {
    let input;
    if (f.type === 'bank') input = bankPicker({ options: f.options, value: f.value, name: f.name, label: f.label, required: f.required, placeholder: f.placeholder });
    else if (f.type === 'select') input = h('select', { name: f.name, required: f.required }, f.options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, t)));
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
    form(fields, needsSetup ? 'Create account' : 'Sign in', async (v) => { S.user = (await api(needsSetup ? '/api/setup' : '/api/login', v)).user; await load(); }),
    !needsSetup && h('p', { class: 'muted small signin-note' }, 'Your login (email and password) is given to you by your admin.')));
}

// ── the page shown: the dashboard, Banks, Transactions, EMIs, Users, or the activity log ──
async function load() {
  // who is signed in, fresh each time a page opens: a changed role shows straight away, removed access signs out.
  // Once someone is signed in, this is asked alongside the page's own data rather than before it (one wait, not two).
  const was = S.user && `${S.user.id}|${S.user.role}`;
  const who = api('/api/state').catch(() => null); // null: offline for a moment — the page itself will say so
  const gone = (st) => st && !st.user;
  // a page left open past midnight moves on to the new day (dates before today are refused for the position)
  const newDay = (st) => { const moved = st.today !== S.today; S.today = st.today; if (!S.date || S.date < st.today) S.date = st.today; return moved; };
  if (!was) {
    const st = await who;
    if (gone(st)) { S.user = null; fresh(); return boot(); }
    if (st) { S.user = st.user; S.ai = Boolean(st.ai); S.docsumo = Boolean(st.docsumo); newDay(st); }
  }
  if ((S.view === 'activity' || S.view === 'users') && !can('admin')) S.view = 'position';
  if (S.view === 'reconcile' && !can('editor')) S.view = 'position';
  const page = ({ position: loadPosition, banks: loadBanks, transactions: loadTransactions, emis: loadEmis, reconcile: loadReconcile, users: loadUsers, activity: loadActivity })[S.view]().then(() => null, (e) => e);
  if (was) {
    const st = await who;
    if (gone(st)) { await page; if (S.user) { S.user = null; fresh(); boot(); } return; } // (a refused request may already have signed out)
    if (st) {
      S.user = st.user; S.ai = Boolean(st.ai); S.docsumo = Boolean(st.docsumo);
      // the role changed, or the day did: open the page again as it now is
      if (`${st.user.id}|${st.user.role}` !== was || newDay(st)) { await page; return load(); }
    }
  }
  const e = await page;
  if (e && S.user) app.replaceChildren(topBar(), h('div', { class: 'card' }, h('p', { class: 'neg' }, e.message), h('button', { onclick: load }, 'Try again')));
}

// simple line icons (stroke paths on a 24×24 grid)
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6', bank: 'M3 21h18M5 21V11M9.5 21V11M14.5 21V11M19 21V11M2 10l10-6 10 6z', swap: 'M4 7h14l-4-4M20 17H6l4 4', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
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
  const items = [['position', 'Dashboard', 'home'], ['banks', 'Banks', 'bank'], ['transactions:records', 'Receipts & Payments', 'swap'], ['transactions:history', 'Transaction History', 'list'],
    can('editor') && ['reconcile', 'Reconcile statement', 'check'], ['emis', 'EMI Management', 'calendar'], can('admin') && ['users', 'Users', 'users'], can('admin') && ['activity', 'Activity Log', 'shield']].filter(Boolean);
  const unread = S.notes?.unread ?? 0;
  if (Date.now() - S.notesAt > 60000) refreshNotes();
  return h('div', { class: 'chrome' },
    h('aside', { class: 'sidebar', 'aria-label': 'Main menu' },
      h('div', { class: 'brand' }, icon('wallet'), h('div', {}, h('strong', {}, 'Finance'), h('small', {}, 'Banks, payments & EMIs'))),
      h('nav', {}, items.map(([k, t, ic]) => h('button', { class: `nav-item ${navKey() === k ? 'on' : ''}`, 'aria-current': navKey() === k ? 'page' : null, onclick: () => go(k) }, icon(ic), h('span', {}, t))))),
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }),
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
      h('span', { class: 'grow' }),
      h('div', { class: 'bell-wrap' },
        h('button', { class: 'icon-btn bell', id: 'bell', 'aria-label': `Reminders${unread ? `, ${unread} unread` : ''}`, onclick: toggleNotes }, icon('bell'), h('span', { class: 'badge', id: 'bell-badge', hidden: !unread }, unread > 99 ? '99+' : unread)),
        h('div', { class: 'notes-panel', id: 'notes', hidden: true })),
      h('div', { class: 'who' }, h('span', { class: 'avatar' }, S.user.name.trim().slice(0, 1).toUpperCase()), h('span', { class: 'who-name' }, S.user.name, h('small', {}, S.user.role)),
        h('button', { class: 'small', onclick: passwordDialog }, 'Change password'),
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
  const tone = { overdue: 'c-red', shortfall: 'c-red', due: 'c-amber', upcoming: 'c-blue', signup: 'c-violet' };
  p.replaceChildren(
    h('div', { class: 'notes-head' }, h('strong', {}, 'Reminders'),
      items.some((n) => !n.read_at) && h('button', { class: 'small', onclick: async () => { await api('/api/notifications/read', { all: true }); S.notesAt = 0; await refreshNotes(); } }, 'Mark all read')),
    // replaceChildren takes each element as its own argument, so the list is spread
    ...(items.length ? items.map((n) => h('button', { class: `note ${n.read_at ? '' : 'unread'}`, onclick: async () => {
      if (!n.read_at) await api('/api/notifications/read', { id: n.id }).catch(() => {});
      S.notesAt = 0; go(n.link === 'people' ? 'users' : 'emis'); // older sign-up notices pointed at People
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
  if (!P.banks.length) warnings.push(can('admin') ? 'Add your bank accounts to start: Banks → “+ Add bank account”.' : 'No bank accounts yet — ask an admin to add them.');
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
      P.banks.length > 0 && h('button', { class: 'c-amber', onclick: () => go('emis') }, 'EMIs')));

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
    { name: 'bank_id', label: out ? 'Paid from' : 'Received in', type: 'bank', value: i.bankId ?? (bankOpts.length === 1 ? bankOpts[0][0] : ''), options: bankOpts, required: true },
    { name: 'date', label: 'Date in the bank', type: 'date', value: S.today, max: S.today, required: true },
    { name: 'ref', label: 'Bank reference (UTR / cheque no.)', required: true },
  ], 'Save', (v) => confirmCode('insufficient', (ok) => api(`/api/${out ? 'payments' : 'receipts'}/${i.id}/settle`, { ...v, confirmShortfall: ok })));
}

function balanceDialog(bankOpts) {
  const yesterday = addDays(S.pos.today, -1);
  openDialog('Enter bank balance', [
    { name: 'bank_id', label: 'Account', type: 'bank', value: bankOpts[0]?.[0], options: bankOpts, required: true },
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
    { name: 'bank_id', label: 'Pay from', type: 'bank', value: anyBank[0][0], options: anyBank },
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
    { name: 'bank_id', label: 'Into account', type: 'bank', value: anyBank[0][0], options: anyBank },
    { name: 'ref', label: 'Invoice no. (optional)' },
    { name: 'note', label: 'Note (optional)' },
  ], 'Add receipt', (v) => confirmDup((dup) => api('/api/receipts', { ...v, confirmDuplicate: dup })));
}

// deleting an account: says what is recorded on it, and asks for its name to be typed
async function bankDeleteDialog(b) {
  let u;
  try { u = await api(`/api/banks/${b.id}/usage`); } catch (e) { return alert(e.message); }
  const lines = [
    u.balances && `${u.balances} balance(s) entered`,
    u.received && `${u.received} receipt(s) of money in — ${inr(u.received_amount)}`,
    u.paid && `${u.paid} payment(s) of money out — ${inr(u.paid_amount)}`,
    u.emis && `${u.emis} EMI(s) set up on this account, with their instalments`,
  ].filter(Boolean);
  const intro = h('div', { class: 'del-intro' },
    h('p', {}, h('strong', {}, `${u.name} — ${u.bank} XXXX${u.last4}`)),
    lines.length
      ? [h('p', { class: 'neg' }, 'Deleting it also deletes:'), h('ul', {}, lines.map((x) => h('li', {}, x))),
        (u.received || u.paid) > 0 && h('p', { class: 'muted small' }, 'Receipts and payments settled through this account are deleted with it; the balances of your other accounts don’t change.')]
      : h('p', { class: 'muted' }, 'Nothing is recorded on this account yet.'),
    u.unassigned > 0 && h('p', { class: 'muted small' }, `${u.unassigned} receipt(s) / payment(s) yet to be paid or received on this account are kept, as “Not decided”.`),
    h('p', { class: 'muted small' }, 'This can’t be undone. It is recorded in the Activity Log.'));
  openDialog('Delete bank account', [{ name: 'confirm', label: `Type “${u.name}” to confirm`, required: true, autocomplete: 'off' }], 'Delete account',
    async (v) => { await api(`/api/banks/${b.id}/delete`, v); if (S.tf?.bank === String(b.id)) S.tf = { ...S.tf, bank: '' }; }, intro);
  dlg.querySelector('button[type=submit]').classList.add('danger');
}

// several bank accounts from one sheet: every row checked first (ready / already there / a problem), then added together
function bankUploadDialog() {
  let sent = null, checked = null;
  const err = h('p', { class: 'err', role: 'alert' }), result = h('div', { class: 'import-result' });
  const fileIn = h('input', { type: 'file', name: 'banksheet', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
  const addBtn = h('button', { class: 'primary', type: 'button', disabled: true }, 'Add');
  const tone = { ok: 'c-green', duplicate: 'c-amber', problem: 'c-red' }, word = { ok: 'Ready', duplicate: 'Already there', problem: 'Problem' };
  const show = () => {
    const rows = checked.rows, ok = rows.filter((r) => r.status === 'ok'), dup = rows.filter((r) => r.status === 'duplicate'), probs = rows.filter((r) => r.status === 'problem');
    addBtn.textContent = ok.length ? `Add ${ok.length} bank account${ok.length === 1 ? '' : 's'}` : 'Nothing to add';
    addBtn.disabled = !ok.length;
    result.replaceChildren(...[
      h('p', { class: 'import-counts' }, h('strong', {}, `${rows.length} account${rows.length === 1 ? '' : 's'}`), checked.sheet && ` in “${checked.sheet}”`, ': ',
        h('span', { class: 'pos' }, `${ok.length} ready`), dup.length > 0 && [' · ', h('span', { class: 'amber' }, `${dup.length} already in the app`)],
        probs.length > 0 && [' · ', h('span', { class: 'red' }, `${probs.length} with a problem (skipped)`)]),
      h('p', { class: 'muted small' }, 'Columns used: ', Object.entries(checked.columns).map(([k, v]) => `${({ name: 'Account name', bank: 'Bank', number: 'Account number', balance: 'Opening balance', date: 'Balance date' })[k]} ← “${v}”`).join(', '), '.'),
      h('div', { class: 'scroll import-preview' }, h('table', { class: 'tx' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Row'), h('th', {}, ''), h('th', {}, 'Account name'), h('th', {}, 'Bank'), h('th', {}, 'Account'), h('th', { class: 'num' }, 'Opening balance'), h('th', {}, 'Notes'))),
        h('tbody', {}, rows.map((r) => h('tr', { class: r.status === 'ok' ? '' : 'inactive' },
          h('td', { class: 'muted' }, r.row),
          h('td', {}, h('span', { class: `chip ${tone[r.status]}` }, word[r.status])),
          h('td', {}, h('strong', {}, r.name || '—')),
          h('td', {}, r.bank || '—'),
          h('td', { class: 'nowrap' }, r.last4 ? `XXXX${r.last4}` : '—'),
          h('td', { class: 'num' }, r.balance == null ? '—' : [money(r.balance), r.asOf && h('div', { class: 'muted small' }, `as of ${nice(r.asOf)}`)]),
          h('td', { class: 'small' }, [...r.problems, r.duplicate, ...r.notes].filter(Boolean).join('; '))))))),
    ].filter(Boolean));
  };
  fileIn.addEventListener('change', async () => {
    err.textContent = ''; result.replaceChildren(); addBtn.disabled = true; checked = null;
    const file = fileIn.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { err.textContent = 'That file is too big. Upload at most 3 MB.'; return; }
    result.append(h('p', { class: 'muted' }, 'Reading the sheet…'));
    try {
      sent = { file: await toBase64(file), name: file.name };
      checked = await api('/api/import/banks/check', sent);
    } catch (e) { result.replaceChildren(); err.textContent = e.message; return; }
    show();
  });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/import/banks/add', sent);
      dlg.close();
      S.flash = `Added ${r.added} bank account${r.added === 1 ? '' : 's'}${r.balances ? ` (${r.balances} with an opening balance)` : ''}${r.skipped ? ` — ${r.skipped} skipped` : ''}.`;
      await load();
    } catch (e) { err.textContent = e.message; addBtn.disabled = false; }
  });
  dlg.className = 'wide import';
  dlg.replaceChildren(
    h('h2', {}, 'Upload bank accounts from Excel'),
    h('p', { class: 'muted' }, 'Add several bank accounts at once: one account per row. Nothing is added until you check the rows below and press Add. ', h('a', { href: '/api/import/banks/sample', download: '' }, 'Download a sample sheet'), '.'),
    h('label', {}, h('span', {}, 'Excel (.xlsx) or CSV file'), fileIn,
      h('small', { class: 'muted' }, 'Needs a heading row with Bank and Account number (only its last 4 digits are kept). Also read if present: Account name, Opening balance and Balance date.')),
    result, err,
    h('div', { class: 'bar' }, addBtn, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  dlg.showModal();
}

function bankDialog() {
  openDialog('Add a bank account', [
    { name: 'name', label: 'Name in this app', placeholder: 'e.g. Main current account', required: true },
    { name: 'bank', label: 'Bank', placeholder: 'e.g. HDFC Bank', required: true },
    { name: 'last4', label: 'Last 4 digits of the account number', required: true },
  ], 'Add account', (v) => api('/api/banks', v), 'Then enter its balance on the Dashboard (“Enter bank balance”), so its figures start from the right amount.');
}

// ── Transactions: money received and paid, bank statements for a period, reports and exports ──
// Only money actually received or paid moves a balance; pending receipts and payments are shown apart.
const monthStart = (d) => `${d.slice(0, 8)}01`;
function period(preset, today = S.today) {
  const [y, m] = today.split('-').map(Number);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'lastmonth') { const end = addDays(monthStart(today), -1); return { from: monthStart(end), to: end }; }
  if (preset === 'fy') return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today }; // Indian financial year, April to March
  if (preset === 'all') return { from: '2000-01-01', to: today };
  return { from: monthStart(today), to: today };
}
const txDefaults = () => ({ preset: 'month', ...period('month'), bank: '', type: '', status: '', q: '', field: '', view: 'history' });
const txQuery = (extra = {}) => {
  const f = S.tf;
  return new URLSearchParams(Object.entries({ view: f.view, from: f.from, to: f.to, bank: f.bank, type: f.type, status: f.view === 'records' ? f.status : '', q: f.q, field: f.q ? f.field : '', ...extra }).filter(([, v]) => v));
};

async function loadTransactions() {
  if (!S.tf) S.tf = txDefaults();
  const [sum, list] = await Promise.all([api(`/api/transactions/summary?${txQuery({ view: '' })}`), api(`/api/transactions?${txQuery()}`)]);
  keepFocus(() => renderTransactions(sum, list.rows));
}

const txId = (r) => `T-${String(r.id).padStart(5, '0')}`;
const recId = (r) => `${r.kind === 'IN' ? 'R' : 'P'}-${r.id}`;
const SEARCH_IN = [['', 'Everything'], ['name', 'Name'], ['id', 'Transaction ID'], ['bank_ref', 'Bank reference (UTR / cheque)'], ['doc_ref', 'Invoice / bill no.'], ['note', 'Description'], ['amount', 'Amount'], ['bank', 'Bank account'], ['user', 'Recorded by']];
const SEARCH_HINT = { '': 'Search name, ID, reference, invoice, amount…', name: 'e.g. Mehta Retail', id: 'e.g. T-00042, R-12 or P-34', bank_ref: 'e.g. UTR number or cheque no.', doc_ref: 'e.g. INV-2291', note: 'e.g. October order', amount: 'e.g. 25000 or 25,000', bank: 'e.g. HDFC', user: 'e.g. Ravi' };
const STATE_LABEL = { pending: 'Yet to be paid', partial: 'Partly settled', completed: 'Completed', cancelled: 'Cancelled' };
const stateLabel = (r) => (r.state === 'pending' && r.kind === 'IN' ? 'Yet to be received' : STATE_LABEL[r.state]);
const STATE_TONE = { pending: 'c-amber', partial: 'c-blue', completed: 'c-green', cancelled: '' };

function renderTransactions(sum, rows) {
  const f = S.tf, T = sum.total, accounts = sum.accounts;
  const bankOpts = accounts.map((b) => [b.id, `${b.name} — ${b.bank} XXXX${b.last4}`]);
  const set = (k) => (e) => { S.tf = { ...S.tf, [k]: e.target.value }; load(); };
  const setDate = (k) => (e) => { if (e.target.value) { S.tf = { ...S.tf, [k]: e.target.value, preset: 'custom' }; load(); } };

  const searchBar = h('div', { class: 'tx-search', role: 'search' },
    h('select', { 'aria-label': 'Search in', class: 'search-in', onchange: (e) => { S.tf = { ...S.tf, field: e.target.value }; if (S.tf.q) load(); else renderTransactions(sum, rows); } },
      SEARCH_IN.map(([v, t]) => h('option', { value: v, selected: (f.field || '') === v }, t))),
    h('input', { type: 'search', name: 'txq', class: 'search', placeholder: SEARCH_HINT[f.field || ''], value: f.q, oninput: onSearch((v) => { S.tf = { ...S.tf, q: v }; }), 'aria-label': 'Search transactions' }),
    f.q && h('button', { class: 'small', 'aria-label': 'Clear search', onclick: () => { S.tf = { ...S.tf, q: '' }; load(); } }, '✕ Clear'),
    f.preset !== 'all' && h('button', { class: 'small', title: 'Search every date, not only the period below', onclick: () => { S.tf = { ...S.tf, preset: 'all', ...period('all') }; load(); } }, 'Search all dates'));
  const filters = h('div', { class: 'card toolbar tx-filters' }, searchBar, h('div', { class: 'bar grow' },
    h('select', { 'aria-label': 'Period', onchange: (e) => { const p = e.target.value; S.tf = { ...S.tf, preset: p, ...(p === 'custom' ? {} : period(p)) }; load(); } },
      [['today', 'Today'], ['month', 'This month'], ['lastmonth', 'Last month'], ['fy', 'This financial year'], ['all', 'All time'], ['custom', 'Custom dates']].map(([v, t]) => h('option', { value: v, selected: f.preset === v }, t))),
    h('label', { class: 'check' }, 'From', h('input', { type: 'date', name: 'from', value: f.from, max: f.to, onchange: setDate('from') })),
    h('label', { class: 'check' }, 'To', h('input', { type: 'date', name: 'to', value: f.to, min: f.from, onchange: setDate('to') })),
    bankPicker({ label: 'Bank account', options: [['', 'All bank accounts'], ...accounts.map((b) => [String(b.id), `${b.name} — ${b.bank} XXXX${b.last4}`])], value: f.bank, onchange: (v) => { S.tf = { ...S.tf, bank: v }; load(); } }),
    h('select', { 'aria-label': 'Type', onchange: set('type') }, [['', 'Receipts and payments'], ['IN', 'Receipts only'], ['OUT', 'Payments only']].map(([v, t]) => h('option', { value: v, selected: f.type === v }, t))),
    f.view === 'records' && h('select', { 'aria-label': 'Status', onchange: set('status') }, [['', 'Any status'], ['pending', 'Yet to be paid / received'], ['partial', 'Partly settled'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([v, t]) => h('option', { value: v, selected: f.status === v }, t)))));

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
        !b.balanceEntered && h('span', { class: 'chip c-amber', title: 'Enter a bank balance on the Dashboard (“Enter bank balance”) so this starts from the right figure.' }, 'no balance entered')),
      h('div', { class: `bc-amt ${b.closing < 0 ? 'neg' : ''}` }, inr(b.closing)),
      line(`Opening (${nice(addDays(sum.from, -1))})`, b.opening),
      line('+ Received', b.received, 'pos'),
      line('− Paid', b.paid, 'red'),
      b.corrections !== 0 && line('± Balance corrections', b.corrections, 'amber', 'A balance entered during the period differs from the running figure — e.g. bank charges or interest not recorded here.'),
      h('div', { class: 'bc-line total' }, h('span', {}, sum.to === sum.today ? '= Current balance' : `= Balance on ${nice(sum.to)}`), money(b.closing)))))
    : h('div', { class: 'card' }, h('p', { class: 'empty' }, can('admin') ? 'No bank accounts yet — add them on the Banks page (“+ Add bank account”).' : 'No bank accounts yet.'));

  const exportBtn = (format, label) => h('button', { class: 'small', onclick: () => {
    const a = h('a', { href: `/api/transactions/export?${txQuery({ format })}`, download: '' });
    document.body.append(a); a.click(); a.remove();
  } }, label);
  const seg = h('div', { class: 'toolbar-row' },
    h('div', { class: 'seg', role: 'tablist' }, [['history', 'Transaction history'], ['records', 'All receipts & payments']].map(([v, t]) =>
      h('button', { class: f.view === v ? 'on' : '', role: 'tab', 'aria-selected': f.view === v ? 'true' : 'false', onclick: () => { if (f.view !== v) { S.tf = { ...S.tf, view: v }; load(); } } }, t))),
    h('div', { class: 'bar' }, h('span', { class: 'muted small result-count' }, f.q ? `${rows.length} result${rows.length === 1 ? '' : 's'} for “${f.q}”${f.field ? ` in ${SEARCH_IN.find(([v]) => v === f.field)[1]}` : ''}` : `${rows.length} row(s)`), exportBtn('csv', 'Export CSV'), exportBtn('xlsx', 'Export Excel')));

  const table = f.view === 'history' ? historyTableEl(rows) : recordsTableEl(rows, bankOpts);
  app.replaceChildren(topBar(),
    pageHead('Receipts, payments & balances', 'Balances move only when money is received or paid. Pending items are shown separately.',
      can('editor') && h('button', { class: 'c-green', onclick: () => txDialog('IN', accounts) }, '+ Receipt'),
      can('editor') && h('button', { class: 'c-red', onclick: () => txDialog('OUT', accounts) }, '+ Payment'),
      can('editor') && h('button', { class: 'primary', onclick: () => uploadDialog() }, '⇪ Upload Excel')),
    ...[flash()].filter(Boolean),
    // while searching, the results come straight under the search bar; the balances follow
    ...(f.q ? [filters, h('section', { class: 'card' }, seg, table), summary, cards] : [filters, summary, cards, h('section', { class: 'card' }, seg, table)]));
}

// a one-time message under the page heading (e.g. after an upload)
function flash() {
  const m = S.flash; S.flash = null;
  return m && h('div', { class: 'card flash', role: 'status' }, icon('check'), h('span', {}, m));
}

// ── upload an Excel / CSV sheet: every good row becomes a payment yet to be paid (or a receipt yet to be received) ──
const toBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const COL_LABEL = { type: 'Type', name: 'Name', amount: 'Amount', out: 'Payment amount', in: 'Receipt amount', date: 'Due date', ref: 'Invoice / bill no.', note: 'Description', category: 'Category', bank: 'Bank account', acct: 'Account no.' };
function uploadDialog(kind = 'OUT') {
  let sent = null, checked = null;
  const err = h('p', { class: 'err', role: 'alert' }), result = h('div', { class: 'import-result' });
  const fileIn = h('input', { type: 'file', name: 'sheet', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
  const kindIn = h('select', { name: 'kind' }, h('option', { value: 'OUT', selected: kind === 'OUT' }, 'Payments — yet to be paid'), h('option', { value: 'IN', selected: kind === 'IN' }, 'Receipts — yet to be received'));
  const dupIn = h('input', { type: 'checkbox', name: 'dups' });
  const addBtn = h('button', { class: 'primary', type: 'button', disabled: true }, 'Add');
  const sample = h('a', { href: '/api/import/sample', download: '' }, 'Download a sample sheet');

  const check = async () => {
    err.textContent = ''; result.replaceChildren(); addBtn.disabled = true; checked = null;
    const file = fileIn.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { err.textContent = 'That file is too big. Upload at most 3 MB.'; return; }
    result.append(h('p', { class: 'muted' }, 'Reading the sheet…'));
    try {
      sent = { file: await toBase64(file), name: file.name, kind: kindIn.value };
      checked = await api('/api/import/check', sent);
    } catch (e) { result.replaceChildren(); err.textContent = e.message; return; }
    show();
  };
  const show = () => {
    const rows = checked.rows, ok = rows.filter((r) => r.status === 'ok'), dup = rows.filter((r) => r.status === 'duplicate'), probs = rows.filter((r) => r.status === 'problem');
    const adding = [...ok, ...(dupIn.checked ? dup : [])];
    const sumOf = (k) => adding.filter((r) => r.kind === k).reduce((n, r) => n + r.amount, 0);
    const nOut = adding.filter((r) => r.kind === 'OUT').length, nIn = adding.length - nOut;
    addBtn.textContent = !adding.length ? 'Nothing to add' : nIn && nOut ? `Add ${adding.length} rows` : nIn ? `Add ${nIn} as yet to be received` : `Add ${nOut} as yet to be paid`;
    addBtn.disabled = !adding.length;
    const tone = { ok: 'c-green', duplicate: 'c-amber', problem: 'c-red' }, word = { ok: 'Ready', duplicate: 'Already there', problem: 'Problem' };
    result.replaceChildren(...[
      h('p', { class: 'import-counts' },
        h('strong', {}, `${rows.length} row${rows.length === 1 ? '' : 's'}`), checked.sheet && ` in “${checked.sheet}”`, ': ',
        h('span', { class: 'pos' }, `${ok.length} ready`),
        dup.length > 0 && [' · ', h('span', { class: 'amber' }, `${dup.length} already in the app`)],
        probs.length > 0 && [' · ', h('span', { class: 'red' }, `${probs.length} with a problem (skipped)`)]),
      adding.length > 0 && h('p', { class: 'muted small' }, [nOut && `To pay: ${inr(sumOf('OUT'))} (${nOut})`, nIn && `To receive: ${inr(sumOf('IN'))} (${nIn})`].filter(Boolean).join(' · '), '. Balances don’t change until each one is marked paid / received.'),
      h('p', { class: 'muted small' }, 'Columns used: ', Object.entries(checked.columns).map(([k, v]) => `${COL_LABEL[k]} ← “${v}”`).join(', '), '.'),
      dup.length > 0 && h('label', { class: 'check' }, dupIn, `Add the ${dup.length} that look already in the app too`),
      h('div', { class: 'scroll import-preview' }, h('table', { class: 'tx' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Row'), h('th', {}, ''), h('th', {}, 'Type'), h('th', {}, 'Name'), h('th', {}, 'Due date'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Account'), h('th', {}, 'Notes'))),
        h('tbody', {}, rows.slice(0, 500).map((r) => h('tr', { class: r.status === 'ok' || (r.status === 'duplicate' && dupIn.checked) ? '' : 'inactive' },
          h('td', { class: 'muted' }, r.row),
          h('td', {}, h('span', { class: `chip ${tone[r.status]}` }, word[r.status])),
          h('td', {}, r.kind === 'IN' ? 'Receipt' : 'Payment'),
          h('td', {}, h('strong', {}, r.name || '—'), [r.ref, r.note].filter(Boolean).length > 0 && h('div', { class: 'muted small' }, [r.ref, r.note].filter(Boolean).join(' · '))),
          h('td', { class: 'nowrap' }, r.date ? nice(r.date) : '—'),
          h('td', { class: 'num' }, r.amount ? inr(r.amount) : '—'),
          h('td', { class: 'small' }, r.bank_name ?? h('span', { class: 'muted' }, 'Not decided')),
          h('td', { class: 'small' }, [...r.problems, r.duplicate, ...r.notes].filter(Boolean).join('; '))))))),
      rows.length > 500 && h('p', { class: 'muted small' }, `Showing the first 500 of ${rows.length} rows.`)].filter(Boolean));
  };
  fileIn.addEventListener('change', check);
  kindIn.addEventListener('change', () => { if (fileIn.files[0]) check(); });
  dupIn.addEventListener('change', () => checked && show());
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/import/add', { ...sent, includeDuplicates: dupIn.checked });
      dlg.close();
      // show what was added: Receipts & Payments, yet to be paid / received, over the dates of the sheet
      const from = r.from < monthStart(S.today) ? r.from : monthStart(S.today), to = r.to > S.today ? r.to : S.today;
      S.view = 'transactions';
      S.tf = { ...txDefaults(), view: 'records', status: 'pending', preset: 'custom', from, to };
      S.flash = `Added ${r.added} from the sheet as yet to be ${r.receipts && r.payments ? 'paid / received' : r.receipts ? 'received' : 'paid'}${r.skipped ? ` (${r.skipped} skipped)` : ''}. Showing everything yet to be paid / received from ${nice(from)} to ${nice(to)}.`;
      await load();
    } catch (e) { err.textContent = e.message; addBtn.disabled = false; }
  });
  dlg.className = 'wide import';
  dlg.replaceChildren(
    h('h2', {}, 'Upload payments / receipts from Excel'),
    h('p', { class: 'muted' }, 'Each row of the sheet is added as yet to be paid (or yet to be received). Nothing is added until you check the rows below and press Add. ', sample, '.'),
    h('label', {}, h('span', {}, 'Excel (.xlsx) or CSV file'), fileIn,
      h('small', { class: 'muted' }, 'Needs a heading row with at least a name (Name / Party / Vendor…) and an amount (Amount…). Also read if present: Type (Payment / Receipt), Due date, Invoice / bill no., Description, Category, Bank account, Account No. (each row is put in the account whose last 4 digits match).')),
    h('label', {}, h('span', {}, 'Rows without a Type column are'), kindIn),
    result, err,
    h('div', { class: 'bar' }, addBtn, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  dlg.showModal();
}

// ── Reconcile: the bank's statement against the payments yet to be paid ──
// Debits in the statement that match a payment are marked paid (only these come off the balance); payments due
// but not in the statement are "left out": paying today, next day, or cancelled.
async function loadReconcile() {
  const sum = await api('/api/transactions/summary');
  // bankId '': the account whose last 4 digits are the statement's account number
  S.rec ??= { bankId: '', anyAccount: false, mismatch: null, data: null, sent: null, choice: new Map(), payee: new Map(), left: new Map(), saveBalance: false, err: '', busy: false };
  S.rec.accounts = sum.accounts;
  renderReconcile();
}
const HOW = { ref: ['bill / ref. no. in narration', 'c-green'], name: ['name in narration', 'c-green'], amount: ['amount only — check', 'c-amber'] };

async function recCheck(file, keepNote = false) {
  const R = S.rec;
  R.err = ''; R.mismatch = null; R.busy = true; if (!keepNote) R.note = ''; renderReconcile();
  try {
    if (file) {
      if (file.size > 3 * 1024 * 1024) throw new Error('That file is too big. Upload at most 3 MB.');
      R.sent = { file: await toBase64(file), name: file.name };
      R.file = file; R.password = ''; R.needPassword = false; R.aiNote = ''; R.anyAccount = false; R.unreadable = false;
      // a photo or screenshot of a statement: this page can't read those itself — the AI or Docsumo does
      if (/^image\//.test(file.type)) {
        R.unreadable = true;
        if (S.ai) return await recAi(true);
        throw new Error(S.docsumo ? 'This page can’t read a photo of a statement itself. Read it with Docsumo (below).'
          : 'A photo of a statement can only be read with AI reading, which isn’t set up for this app. Upload the PDF, Excel or CSV statement, or paste it.');
      }
    }
    try {
      R.data = await api('/api/reconcile/check', { ...R.sent, password: R.password, bank_id: R.bankId, anyAccount: R.anyAccount });
    } catch (e) {
      // a picture of a statement (no text in the PDF): read it here with OCR, then check what was read
      if (e.code !== 'pdf_no_text' || !file) throw e;
      R.sent.ocr = await ocrPdf(file, R.password, (msg) => { R.progress = msg; renderReconcile(); })
        .catch((x) => { throw Object.assign(x, { detail: { unreadable: true } }); });
      R.progress = '';
      R.data = await api('/api/reconcile/check', { ...R.sent, password: R.password, bank_id: R.bankId, anyAccount: R.anyAccount });
    }
    R.needPassword = false;
    R.choice = firstChoices(R.data);
    R.payee = new Map(); R.left = new Map(); R.leftIn = new Map(); R.saveBalance = false;
  } catch (e) { recFailed(e); if (e.code === 'pdf_password') R.needPassword = true; }
  R.busy = false; renderReconcile();
}
// a statement whose account number isn't the chosen account's: say so, and offer the right one (or to go ahead)
function recFailed(e) {
  const R = S.rec;
  R.err = e.message; R.data = null; R.progress = '';
  R.mismatch = e.code === 'account_mismatch' ? e.detail ?? {} : null;
  if (e.detail?.unreadable) R.unreadable = true; // this page's own reader couldn't read it: Docsumo is offered
}
// what each statement line starts as: its matched payment / receipt; money that came in and matches nothing is set to
// be recorded as a new receipt (so Apply brings the account to the bank's position) — unless it might be one of the
// receipts expected (same amount), was reversed, or doesn't add up: those wait for a choice
const firstChoices = (data) => new Map([
  ...data.debits.filter((d) => !d.recorded).map((d) => [d.row, d.match ? String(d.match.id) : '']),
  ...data.credits.filter((d) => !d.recorded).map((d) => [d.row, d.match ? String(d.match.id) : !d.reversedBy && !d.reverses && !d.mismatch && !d.candidates.length ? 'rec' : '']),
]);
// read the chosen file with Claude (any PDF, or a photo): its lines are then checked like any other statement
async function recAi(busy = false) {
  const R = S.rec;
  if (!busy) { R.err = ''; R.mismatch = null; R.note = ''; R.busy = true; }
  R.progress = 'Claude (AI) is reading the statement — this can take up to a minute…'; renderReconcile();
  try {
    const r = await api('/api/reconcile/ai-read', { file: R.sent.file, name: R.sent.name });
    R.sent = { file: R.sent.file, name: R.sent.name, lines: r.lines, account: r.account };
    R.aiNote = r.note;
    R.progress = 'Checking what was read…'; renderReconcile();
    R.data = await api('/api/reconcile/check', { ...R.sent, bank_id: R.bankId, anyAccount: R.anyAccount });
    R.choice = firstChoices(R.data);
    R.payee = new Map(); R.left = new Map(); R.leftIn = new Map(); R.saveBalance = false;
  } catch (e) { recFailed(e); }
  R.progress = ''; R.busy = false; renderReconcile();
}
// read the chosen file with Docsumo — only offered when this page couldn't read it: Docsumo reads in the background,
// so the file is sent, then asked for every few seconds until it is read; its lines are checked like any other statement
async function recDocsumo() {
  const R = S.rec, { file, name } = R.sent;
  R.err = ''; R.mismatch = null; R.note = ''; R.busy = true;
  R.progress = 'Sending the statement to Docsumo…'; renderReconcile();
  try {
    const { docId } = await api('/api/reconcile/docsumo-read', { file, name });
    let r = { ready: false };
    for (let i = 0; !r.ready; i++) {
      if (i >= 100) throw new Error('Docsumo is taking too long to read this statement. Try again in a few minutes.');
      R.progress = `Docsumo is reading the statement — this can take a minute or two${i ? ` (${i * 3} s)` : ''}…`; renderReconcile();
      await new Promise((ok) => setTimeout(ok, i ? 3000 : 1500));
      r = await api('/api/reconcile/docsumo-result', { docId, name });
    }
    R.sent = { file, name, lines: r.lines, account: r.account, reader: 'docsumo' };
    R.aiNote = '';
    R.progress = 'Checking what was read…'; renderReconcile();
    R.data = await api('/api/reconcile/check', { ...R.sent, bank_id: R.bankId, anyAccount: R.anyAccount });
    R.choice = firstChoices(R.data);
    R.payee = new Map(); R.left = new Map(); R.leftIn = new Map(); R.saveBalance = false;
  } catch (e) { recFailed(e); }
  R.progress = ''; R.busy = false; renderReconcile();
}
// ── OCR: the words on each page of a picture-only PDF, with where they are (PDF points, y up, as pdf.js gives text) ──
const loadScript = (src) => new Promise((ok, no) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  document.head.append(h('script', { src, onload: ok, onerror: () => no(new Error('The reader for pictures of statements didn’t load. Check the connection and try again.')) }));
});
async function ocrPdf(file, password, progress) {
  progress('Opening the PDF…');
  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: password || undefined, isEvalSupported: false }).promise;
  if (doc.numPages > 20) throw new Error('That picture PDF has more than 20 pages. Upload a shorter period.');
  progress('Loading the reader (the first time takes a few seconds)…');
  await loadScript('/vendor/tesseract.min.js');
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: '/vendor/tesseract-worker.min.js', corePath: '/vendor/tesseract-core-simd-lstm.wasm.js', langPath: '/vendor', gzip: true, workerBlobURL: false,
  });
  const SCALE = 3, pages = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' }); // words wherever they are on the page
    for (let p = 1; p <= doc.numPages; p++) {
      progress(`Reading the picture of the statement: page ${p} of ${doc.numPages}…`);
      const page = await doc.getPage(p), vp = page.getViewport({ scale: SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      // black and white: light grey headings read as clearly as the figures
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
      for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 215 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
      ctx.putImageData(img, 0, 0);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const words = [];
      for (const b of data.blocks ?? []) for (const par of b.paragraphs) for (const l of par.lines) for (const w of l.words) {
        const base = w.baseline && Number.isFinite(w.baseline.y0) ? (w.baseline.y0 + w.baseline.y1) / 2 : w.bbox.y1;
        words.push({ x: w.bbox.x0 / SCALE, y: (vp.height - base) / SCALE, w: (w.bbox.x1 - w.bbox.x0) / SCALE, h: (w.bbox.y1 - w.bbox.y0) / SCALE, s: w.text });
      }
      pages.push({ top: vp.height / SCALE, words });
    }
  } finally { await worker.terminate(); }
  return pages;
}

// bank charges, fees and the GST on them: recorded together with one button
const CHARGE = /charge|chrg|chgs|commission|\bfee\b|fees|gst|service\s*tax|sms\s*alert|min(imum)?\s*bal/i;

function renderReconcile() {
  const R = S.rec, D = R.data;
  const fileIn = h('input', { type: 'file', name: 'statement', accept: `.pdf,.xlsx,.csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv${S.ai || S.docsumo ? ',.png,.jpg,.jpeg,image/png,image/jpeg' : ''}${S.docsumo ? ',.tif,.tiff,image/tiff' : ''}`, onchange: (e) => e.target.files[0] && recCheck(e.target.files[0]) });
  // AI reading: offered for a PDF or a photo once one is chosen, most of all when OCR couldn't confirm every line
  const canAi = S.ai && R.file && /pdf|image/.test(R.file.type || (/\.pdf$/i.test(R.file.name) ? 'pdf' : '')) && !R.busy && !D?.ai;
  const aiOffer = canAi && h('div', { class: `rec-ai ${D?.checked && D.checked.ok < D.checked.of ? 'urge' : ''}` },
    h('button', { class: 'small primary', onclick: () => recAi() }, D ? '✨ Read it with AI instead' : '✨ Read with AI'),
    h('span', { class: 'muted small' }, D?.checked && D.checked.ok < D.checked.of ? 'Some lines don’t add up — Claude (AI) may read them better. ' : R.err ? 'Claude (AI) can read PDFs this page can’t, and photos of statements. ' : '',
      'The statement is sent to Anthropic to be read; the figures are checked against the running balance as usual.'));
  // Docsumo: only for a PDF or photo this page couldn't read itself — not read, or read with lines that don't add up
  const ownMisread = D && !D.ai && !D.docsumo && D.checked && D.checked.ok < D.checked.of;
  const docFile = R.file && /pdf|image/.test(R.file.type || (/\.(pdf|png|jpe?g|tiff?)$/i.test(R.file.name) ? 'pdf' : ''));
  const canDocsumo = docFile && !R.busy && !D?.docsumo && (R.unreadable || ownMisread);
  const docsumoOffer = canDocsumo && (S.docsumo
    ? h('div', { class: 'rec-ai urge' },
      h('button', { class: 'small primary', onclick: () => recDocsumo() }, D ? 'Read it with Docsumo instead' : 'Read with Docsumo'),
      h('span', { class: 'muted small' }, ownMisread ? 'Some lines this page read don’t add up — Docsumo may read them better. ' : 'This page couldn’t read this statement itself — Docsumo can. ',
        'The statement is sent to Docsumo to be read; the figures are checked against the running balance as usual.'))
    : can('admin') && h('p', { class: 'muted small' }, 'Reading with Docsumo (for statements this page can’t read) is off: add a DOCSUMO_API_KEY to the app’s settings to turn it on.'));
  const pwIn = h('input', { type: 'password', name: 'pdfPassword', autocomplete: 'off', placeholder: 'PDF password', 'aria-label': 'PDF password' });
  const pasteIn = h('textarea', { name: 'pasted', rows: '4', placeholder: 'Or paste the statement here: in the bank’s email, select the table (from the column headings to the last line), copy, and paste.', 'aria-label': 'Paste the statement' });
  const step = h('section', { class: 'card rec-step' },
    h('div', { class: 'bar grow' },
      h('label', {}, h('span', {}, 'Bank account'), bankPicker({ name: 'bank', label: 'Bank account', value: R.bankId,
        options: [['', 'From the statement (last 4 digits of its account no.)'], ...R.accounts.map((b) => [String(b.id), `${b.name} — ${b.bank} XXXX${b.last4}`])],
        onchange: (v) => { R.bankId = v; R.anyAccount = false; if (R.sent) recCheck(); } })),
      h('label', {}, h('span', {}, 'Bank statement (PDF, Excel or CSV)'), fileIn)),
    R.needPassword && h('div', { class: 'bar' }, pwIn, h('button', { class: 'small primary', onclick: () => { R.password = pwIn.value; recCheck(null, true); } }, 'Open PDF')),
    h('div', { class: 'rec-paste' }, pasteIn, h('button', { class: 'small', onclick: () => { const t = pasteIn.value.trim(); if (t) recCheck(new File([t], 'pasted statement.txt', { type: 'text/plain' })); } }, 'Read pasted statement')),
    h('p', { class: 'muted small' }, 'It is read for: date, narration / particulars, cheque or reference no., withdrawal (debit) and balance. A PDF saved as a picture (e.g. with “Microsoft Print to PDF”) is read here with OCR, and every line is checked against the running balance. Nothing changes until you press Apply.'),
    R.sent && h('p', { class: 'small' }, 'File: ', h('strong', {}, R.sent.name), D && ` · ${nice(D.from)} – ${nice(D.to)} · ${D.debits.length} payment(s) out, ${D.credits.length} credit(s) in`),
    // read fine, but nothing moved in the account
    D && !D.debits.length && !D.credits.length && h('p', { class: 'rec-ocr' }, icon('check'), h('span', {}, `Read: no money went in or out of ${D.bank.name} in this statement.`)),
    R.busy && h('p', { class: 'muted' }, R.progress || 'Reading the statement…'),
    D?.ai && h('p', { class: `rec-ocr ${D.checked && D.checked.ok < D.checked.of ? 'warn' : ''}` }, icon(D.checked && D.checked.ok === D.checked.of ? 'check' : 'alert'),
      h('span', {}, 'Read by AI (Claude). ', D.checked
        ? (D.checked.ok === D.checked.of ? `The running balance confirms all ${D.checked.of} lines.` : `The running balance confirms ${D.checked.ok} of ${D.checked.of} lines — the others are flagged below and aren’t matched automatically; check them against the statement.`)
        : 'The statement has no balance column to check the figures against — compare the amounts with the statement before applying.',
      R.aiNote ? ` The AI noted: “${R.aiNote}”` : '')),
    D?.docsumo && h('p', { class: `rec-ocr ${D.checked && D.checked.ok < D.checked.of ? 'warn' : ''}` }, icon(D.checked && D.checked.ok === D.checked.of ? 'check' : 'alert'),
      h('span', {}, 'Read by Docsumo (this page couldn’t read it). ', D.checked
        ? (D.checked.ok === D.checked.of ? `The running balance confirms all ${D.checked.of} lines.` : `The running balance confirms ${D.checked.ok} of ${D.checked.of} lines — the others are flagged below and aren’t matched automatically; check them against the statement.`)
        : 'The statement has no balance column to check the figures against — compare the amounts with the statement before applying.')),
    D?.ocr && h('p', { class: `rec-ocr ${D.checked && D.checked.ok < D.checked.of ? 'warn' : ''}` }, icon(D.checked && D.checked.ok === D.checked.of ? 'check' : 'alert'),
      h('span', {}, 'Read from a picture of the statement (OCR). ', D.checked
        ? (D.checked.ok === D.checked.of ? `The running balance confirms all ${D.checked.of} lines.` : `The running balance confirms ${D.checked.ok} of ${D.checked.of} lines — the others are flagged below and aren’t matched automatically; check them against the statement.`)
        : 'The statement has no balance column to check the figures against — compare the amounts with the statement before applying.')),
    D && !D.ocr && D.checked && D.checked.ok < D.checked.of && h('p', { class: 'rec-ocr warn' }, icon('alert'), h('span', {}, `The running balance confirms ${D.checked.ok} of ${D.checked.of} lines — the others are flagged below.`)),
    // the account the statement is reconciled with, and how it was found
    D && h('p', { class: `rec-ocr ${D.account.agrees === false ? 'warn' : ''}` }, icon(D.account.agrees === false ? 'alert' : 'check'),
      h('span', {}, D.account.last4 == null ? `The statement doesn’t show its account number: reconciling with ${D.bank.name} (${D.bank.bank} XXXX${D.bank.last4}), as chosen.`
        : D.account.agrees ? `Statement account XXXX${D.account.last4} → ${D.bank.name} (${D.bank.bank} XXXX${D.bank.last4})${D.account.by === 'statement' ? ', found by its last 4 digits' : ''}. What is recorded from it goes to this account.`
          : `The statement shows account XXXX${D.account.last4}, but it is being reconciled with ${D.bank.name} (XXXX${D.bank.last4}), as you chose.`)),
    R.err && h('p', { class: 'err', role: 'alert' }, R.err),
    R.mismatch && h('div', { class: 'bar' },
      R.mismatch.suggest && h('button', { class: 'small primary', onclick: () => { R.bankId = String(R.mismatch.suggest); R.anyAccount = false; recCheck(null, true); } },
        `Use ${R.accounts.find((b) => b.id === R.mismatch.suggest)?.name ?? 'that account'} (XXXX${R.mismatch.last4})`),
      h('button', { class: 'small', onclick: () => { R.anyAccount = true; recCheck(null, true); } }, 'Reconcile with the chosen account anyway')),
    docsumoOffer,
    aiOffer,
    !S.ai && can('admin') && h('p', { class: 'muted small' }, 'AI reading (for statements this page can’t read, and photos of statements) is off: add an ANTHROPIC_API_KEY to the app’s settings to turn it on.'));
  if (!R.accounts.length) return app.replaceChildren(topBar(), pageHead('Reconcile with the bank statement', ''), h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Add a bank account first (Banks → “+ Add bank account”).')));
  const parts = [topBar(), pageHead('Reconcile with the bank statement', 'What the statement shows went out is marked paid, and what came in is marked received — so the app shows the bank’s actual position. What was due but isn’t in it is listed so you can decide.'), R.note && h('div', { class: 'card flash', role: 'status' }, icon('check'), h('span', {}, R.note)), step].filter(Boolean);
  if (!D) return app.replaceChildren(...parts);

  const total = (xs, k = 'amount') => xs.reduce((n, x) => n + x[k], 0);
  const rerender = () => keepFocus(renderReconcile);
  // the two sides: money out (statement debits ↔ payments yet to be paid) and money in (credits ↔ receipts yet to be received)
  const side = (out) => {
    const lines = out ? D.debits : D.credits, list = out ? D.payments : D.receipts, left = out ? R.left : R.leftIn;
    const items = new Map(list.map((p) => [String(p.id), p]));
    const open = lines.filter((d) => !d.recorded), done = lines.filter((d) => d.recorded);
    const matched = open.filter((d) => items.has(R.choice.get(d.row))), notIn = open.filter((d) => !items.has(R.choice.get(d.row)));
    const chosen = new Map(matched.map((d) => [R.choice.get(d.row), d.row]));
    const leftOut = (out ? D.due : D.dueIn).map((id) => items.get(String(id))).filter((p) => p && !chosen.has(String(p.id)));
    return { out, lines, items, open, done, matched, notIn, chosen, leftOut, left, rec: notIn.filter((d) => R.choice.get(d.row) === 'rec'),
      w: out ? { id: 'P', thing: 'payment', things: 'payments', did: 'paid', to: 'Pay to', due: 'due', yet: 'yet to be paid', soon: 'Paying today', sign: -1, verb: 'pay' }
        : { id: 'R', thing: 'receipt', things: 'receipts', did: 'received', to: 'Received from', due: 'expected', yet: 'yet to be received', soon: 'Expected today', sign: 1, verb: 'receive' } };
  };
  const O = side(true), I = side(false);
  const recLabel = (S, p) => `${S.w.id}-${p.id} · ${p.name} · ${S.w.due} ${nice(p.due_date)} · ${inr(p.outstanding)}${p.outstanding < p.amount ? ' left' : ''}${!p.bank_name ? ' · bank not decided' : p.bank_id !== D.bank.id ? ` · for ${p.bank_name}` : ''}`;
  const amountCell = (S, d) => h('td', { class: 'num' }, money(S.w.sign * d.amount, S.out ? '' : 'pos'));

  const lineCell = (S, d) => h('td', {}, h('div', {}, d.narration || '—'), h('div', { class: 'muted small' }, [d.ref && `Ref. ${d.ref}`, `row ${d.row}`].filter(Boolean).join(' · ')),
    d.mismatch && h('div', { class: 'chip c-red', title: 'The balance before it, with this line, isn’t the balance shown on this line: a figure may be misread.' }, `doesn’t add up: balance shows ${inr(d.mismatch.shown)}, expected ${inr(d.mismatch.expected)}`),
    d.reversedBy && h('div', { class: 'chip', title: 'The bank undid this later in the statement (a reversal, or a returned cheque).' }, `reversed by the bank (row ${d.reversedBy}) — not a ${S.w.thing}`),
    d.reverses && h('div', { class: 'chip', title: 'This undoes an earlier line of the statement (a reversal, or a returned cheque).' }, `the bank undoing row ${d.reverses} — not a ${S.w.thing}`));
  const select = (S, d) => {
    const ids = [...new Set([d.match?.id, ...d.candidates].filter(Boolean).map(String))];
    return h('select', { 'aria-label': `${S.out ? 'Payment' : 'Receipt'} for statement row ${d.row}`, onchange: (e) => { R.choice.set(d.row, e.target.value); rerender(); } },
      h('option', { value: '' }, ids.length ? 'Not in the app' : `Not in the app (no ${S.w.thing} of this amount)`),
      ids.map((id) => S.items.get(id)).filter(Boolean).map((p) => h('option', { value: String(p.id), selected: R.choice.get(d.row) === String(p.id), disabled: S.chosen.has(String(p.id)) && S.chosen.get(String(p.id)) !== d.row }, recLabel(S, p))),
      h('option', { value: 'rec', selected: R.choice.get(d.row) === 'rec', disabled: Boolean(d.reversedBy || d.reverses) }, `+ Record it as a new ${S.w.thing}`));
  };
  const howChip = (S, d) => {
    const id = R.choice.get(d.row), p = S.items.get(id);
    if (!p) return null;
    const auto = d.match && String(d.match.id) === id ? HOW[d.match.how] : ['chosen by you', 'c-blue'];
    return h('div', { class: 'chips' }, h('span', { class: `chip ${auto[1]}` }, auto[0]), d.amount < p.outstanding && h('span', { class: 'chip c-blue' }, `part: ${inr(p.outstanding - d.amount)} stays to ${S.w.verb}`),
      // no account on the slip: the statement says which one it went through
      p.bank_id == null && h('span', { class: 'chip c-blue', title: 'It had no bank account. Applying records it in the account of this statement.' }, `account not decided → ${S.w.did} ${S.out ? 'from' : 'into'} ${D.bank.name}`));
  };
  const table = (S, rows, head, cells, foot) => h('div', { class: 'scroll' }, h('table', { class: 'tx rec' },
    h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: i === 2 ? 'num' : '' }, t)))), h('tbody', {}, rows.map((d) => h('tr', {}, cells(d)))), foot && h('tfoot', {}, foot)));

  const matchedSec = (S) => h('section', { class: 'card' },
    h('h2', {}, h('span', { class: `dot ${S.out ? 'd-red' : 'd-green'}` }, ), `${S.out ? 'Paid' : 'Received'} — found in the statement (${S.matched.length})`),
    h('p', { class: 'muted small' }, `These are marked ${S.w.did} on the statement date and ${S.out ? 'come off' : 'are added to'} the balance. Check the ones matched on amount only; change or clear the ${S.w.thing} if it is wrong.`),
    S.matched.length ? table(S, S.matched, ['Date', 'Statement narration', 'Amount', `${S.out ? 'Payment' : 'Receipt'} in the app`],
      (d) => [h('td', { class: 'nowrap' }, nice(d.date)), lineCell(S, d), amountCell(S, d), h('td', {}, select(S, d), howChip(S, d))],
      h('tr', {}, h('td', { colspan: '2' }, `Total marked ${S.w.did}`), h('td', { class: 'num' }, money(S.w.sign * total(S.matched), S.out ? '' : 'pos')), h('td', {})))
      : h('p', { class: 'empty' }, `No statement ${S.out ? 'debit' : 'credit'} matches a ${S.w.thing} ${S.w.yet}.`));

  const leftSec = (S) => h('section', { class: 'card' },
    h('h2', {}, h('span', { class: 'dot d-amber' }), S.out ? `Left out — due by ${nice(D.to)}, not in the statement (${S.leftOut.length})` : `Expected but not in the statement — due by ${nice(D.to)} (${S.leftOut.length})`),
    h('p', { class: 'muted small' }, `${S.out ? 'Payments' : 'Receipts'} for ${D.bank.name} (or with no bank decided) that were ${S.w.due} by the statement’s last day but aren’t in it. They stay ${S.w.yet} until you decide.`),
    // with no account decided, it may be in another account's statement: "Set all" leaves those alone
    S.leftOut.some((p) => p.bank_id == null) && h('p', { class: 'muted small' }, `The ones with no bank account decided may have been ${S.w.did} through another account: reconcile that account’s statement too before cancelling them. “Set all” leaves them as they are.`),
    S.leftOut.some((p) => p.bank_id != null) && h('div', { class: 'bar' }, h('span', { class: 'muted small' }, 'Set all:'),
      [['today', S.w.soon], ['tomorrow', 'Next day'], ['cancel', 'Cancelled'], ['', 'Decide later']].map(([v, t]) =>
        h('button', { class: 'small', onclick: () => { for (const p of S.leftOut) if (p.bank_id != null && (v === '' || v === 'cancel' || !p.emi)) S.left.set(p.id, v); rerender(); } }, t))),
    S.leftOut.length ? h('div', { class: 'scroll' }, h('table', { class: 'tx rec' },
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, S.w.to), h('th', {}, S.out ? 'Due' : 'Expected'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'What happens'))),
      h('tbody', {}, S.leftOut.map((p) => h('tr', {},
        h('td', { class: 'nowrap tx-id' }, `${S.w.id}-${p.id}`),
        h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted small' }, [p.ref, p.emi ? 'EMI' : p.category, p.bank_name ?? 'bank not decided'].filter(Boolean).join(' · '))),
        h('td', { class: 'nowrap' }, nice(p.due_date)),
        h('td', { class: 'num' }, money(p.outstanding)),
        h('td', {}, h('select', { 'aria-label': `What happens to ${S.w.id}-${p.id}`, class: `left-${S.left.get(p.id) || 'none'}`, onchange: (e) => { S.left.set(p.id, e.target.value); rerender(); } },
          [['', 'Decide later'], ['today', S.w.soon], ['tomorrow', 'Next day'], ['cancel', 'Cancelled']].map(([v, t]) =>
            h('option', { value: v, selected: (S.left.get(p.id) || '') === v, disabled: p.emi && (v === 'today' || v === 'tomorrow') }, t))),
          p.emi && h('div', { class: 'muted small' }, 'EMI: keeps its date'))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: '3' }, 'Total'), h('td', { class: 'num' }, money(total(S.leftOut, 'outstanding'))), h('td', {})))))
      : h('p', { class: 'empty' }, `Nothing left out: every ${S.w.thing} ${S.w.due} was in the statement.`));

  // record every line not in the app with one click (not the ones the bank reversed), named from the narration
  const recordable = (S) => S.notIn.filter((d) => !d.reversedBy && !d.reverses);
  const setRec = (list, v) => { for (const d of list) R.choice.set(d.row, v); rerender(); };
  const notInSec = (S) => S.notIn.length > 0 && h('section', { class: 'card' },
    h('h2', {}, h('span', { class: 'dot d-blue' }), `Money ${S.out ? 'out' : 'in'}, not in the app (${S.notIn.length})`),
    h('p', { class: 'muted small' }, S.out ? 'Money that left the account but matches no payment here (e.g. bank charges, or a payment not in the sheet). Match it to a payment, record it as a new one, or leave it.'
      : 'Money that came into the account but matches no receipt here (e.g. a customer’s payment, a cash deposit, a refund). Match it to a receipt, record it as a new one, or leave it.'),
    (() => {
      const all = recordable(S).filter((d) => R.choice.get(d.row) !== 'rec'), chosen = recordable(S).filter((d) => R.choice.get(d.row) === 'rec');
      const ch = S.out ? all.filter((d) => CHARGE.test(d.narration)) : [];
      return (all.length > 0 || chosen.length > 0) && h('div', { class: 'bar rec-bulk' },
        all.length > 0 && h('button', { class: 'small primary', onclick: () => setRec(all, 'rec') }, `+ Record all ${all.length} as new ${all.length === 1 ? S.w.thing : S.w.things} (${inr(total(all))})`),
        ch.length > 0 && ch.length < all.length && h('button', { class: 'small', onclick: () => setRec(ch, 'rec') }, `Record just the ${ch.length} bank charge${ch.length === 1 ? '' : 's'} (${inr(total(ch))})`),
        chosen.length > 0 && h('button', { class: 'small', onclick: () => setRec(chosen, '') }, 'Leave them all'),
        all.length > 0 && h('span', { class: 'muted small' }, `Each is recorded as ${S.w.did} on its statement date, named from the narration — change any name before applying.`));
    })(),
    table(S, S.notIn, ['Date', 'Statement narration', 'Amount', `${S.out ? 'Payment' : 'Receipt'} in the app`],
      (d) => [h('td', { class: 'nowrap' }, nice(d.date)), lineCell(S, d), amountCell(S, d),
        h('td', {}, select(S, d), R.choice.get(d.row) === 'rec' && h('input', { name: `payee-${d.row}`, 'aria-label': S.w.to, placeholder: S.w.to, value: R.payee.get(d.row) ?? d.payee ?? d.narration.slice(0, 60), oninput: (e) => R.payee.set(d.row, e.target.value) }))]));

  const done = [...O.done, ...I.done].sort((a, b) => a.row - b.row);
  const doneSec = done.length > 0 && h('details', { class: 'card' }, h('summary', {}, `Already in the app (${done.length}) — recorded before, not counted again`),
    h('ul', { class: 'day-moves' }, done.map((d) => h('li', {}, h('span', {}, nice(d.date), ' · ', d.narration || d.ref, h('span', { class: 'muted small' }, ` · matched by ${d.recorded.by}`)),
      money(d.recorded.payment_id !== undefined ? -d.amount : d.amount, d.recorded.payment_id !== undefined ? '' : 'pos')))));

  // the final position: the app after applying, against the statement's closing balance
  const paidAmt = total(O.matched) + total(O.rec), recvAmt = total(I.matched) + total(I.rec);
  const after = D.appClosing - paidAmt + recvAmt;
  const balSec = h('section', { class: 'card rec-balance' },
    h('div', { class: 'bc-line' }, h('span', {}, `${D.bank.name} in the app on ${nice(D.to)}, now`), money(D.appClosing)),
    h('div', { class: 'bc-line' }, h('span', {}, '− Paid, from this statement'), money(-paidAmt, 'red')),
    h('div', { class: 'bc-line' }, h('span', {}, '+ Received, from this statement'), money(recvAmt, 'pos')),
    h('div', { class: 'bc-line total' }, h('span', {}, '= In the app after applying'), money(after)),
    D.closing && h('div', { class: 'bc-line' }, h('span', {}, `Statement closing balance (${nice(D.closing.date)})`), money(D.closing.amount)),
    D.closing && (after === D.closing.amount
      ? h('p', { class: 'rec-ocr' }, icon('check'), h('span', {}, 'After applying, the app matches the bank exactly.'))
      : h('p', { class: 'muted small' }, `Difference ${inr(D.closing.amount - after)}: lines in the statement not recorded above, or a balance not entered for ${D.bank.name}.`)),
    D.closing && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'saveBalance', checked: R.saveBalance, onchange: (e) => { R.saveBalance = e.target.checked; rerender(); } }),
      `Also save ${inr(D.closing.amount)} as ${D.bank.name}’s balance at the end of ${nice(D.closing.date)}`));

  // everything not in the app, out and in, in one click — for the bank's actual position
  const allOut = recordable(O).filter((d) => R.choice.get(d.row) !== 'rec'), allIn = recordable(I).filter((d) => R.choice.get(d.row) !== 'rec');
  const everything = allOut.length + allIn.length > 0 && h('div', { class: 'card rec-all' },
    h('button', { class: 'primary', onclick: () => setRec([...allOut, ...allIn], 'rec') },
      `+ Record everything not in the app: ${[allOut.length && `${allOut.length} payment${allOut.length === 1 ? '' : 's'} (${inr(total(allOut))})`, allIn.length && `${allIn.length} receipt${allIn.length === 1 ? '' : 's'} (${inr(total(allIn))})`].filter(Boolean).join(' and ')}`),
    h('span', { class: 'muted small' }, 'With what is matched, the app then shows the bank’s actual position. Review the names below, then Apply.'));

  const n = (m, v) => [...m.values()].filter((x) => x === v).length;
  const summary = [O.matched.length && `${O.matched.length} marked paid (${inr(total(O.matched))})`, O.rec.length && `${O.rec.length} payment${O.rec.length === 1 ? '' : 's'} recorded as new`,
    I.matched.length && `${I.matched.length} marked received (${inr(total(I.matched))})`, I.rec.length && `${I.rec.length} receipt${I.rec.length === 1 ? '' : 's'} recorded as new`,
    n(R.left, 'today') && `${n(R.left, 'today')} paying today`, n(R.left, 'tomorrow') && `${n(R.left, 'tomorrow')} next day`, n(R.left, 'cancel') && `${n(R.left, 'cancel')} cancelled`,
    n(R.leftIn, 'today') && `${n(R.leftIn, 'today')} expected today`, n(R.leftIn, 'tomorrow') && `${n(R.leftIn, 'tomorrow')} receipt${n(R.leftIn, 'tomorrow') === 1 ? '' : 's'} next day`,
    n(R.leftIn, 'cancel') && `${n(R.leftIn, 'cancel')} receipt${n(R.leftIn, 'cancel') === 1 ? '' : 's'} cancelled`, R.saveBalance && 'balance saved'].filter(Boolean);
  const name = (d) => R.payee.get(d.row) ?? d.payee ?? d.narration.slice(0, 60);
  const lefts = (S) => [...S.left].filter(([id, v]) => v && S.leftOut.some((p) => p.id === id)).map(([id, action]) => ({ id, action }));
  const applyBtn = h('button', { class: 'primary', disabled: !summary.length || R.busy, onclick: async () => {
    if (!confirm(`Apply to ${D.bank.name}?\n\n${summary.join('\n')}`)) return;
    R.busy = true; renderReconcile();
    try {
      const r = await api('/api/reconcile/apply', { ...R.sent, password: R.password, bank_id: R.bankId, anyAccount: R.anyAccount, saveBalance: R.saveBalance,
        matches: O.matched.map((d) => ({ row: d.row, id: Number(R.choice.get(d.row)) })), record: O.rec.map((d) => ({ row: d.row, payee: name(d) })), leftOut: lefts(O),
        matchesIn: I.matched.map((d) => ({ row: d.row, id: Number(R.choice.get(d.row)) })), recordIn: I.rec.map((d) => ({ row: d.row, party: name(d) })), leftOutIn: lefts(I) });
      R.note = [`Reconciled ${D.bank.name}:`, r.paid && `${r.paid} payment(s) marked paid (${inr(r.paidAmount)})`, r.recorded && `${r.recorded} payment(s) recorded as new (${inr(r.recordedAmount)})`,
        r.assigned && `(${r.assigned} with no account now in ${D.bank.name})`,
        r.received && `${r.received} receipt(s) marked received (${inr(r.receivedAmount)})`, r.assignedIn && `(${r.assignedIn} with no account now in ${D.bank.name})`, r.recordedIn && `${r.recordedIn} receipt(s) recorded as new (${inr(r.recordedInAmount)})`,
        r.today && `${r.today} moved to today`, r.tomorrow && `${r.tomorrow} moved to tomorrow`, r.cancelled && `${r.cancelled} cancelled`,
        r.inToday && `${r.inToday} receipt(s) expected today`, r.inTomorrow && `${r.inTomorrow} receipt(s) moved to tomorrow`, r.inCancelled && `${r.inCancelled} receipt(s) cancelled`,
        r.balanceSaved && 'statement balance saved'].filter(Boolean).join(' ');
      R.busy = false;
      await recCheck(null, true); // the same statement again: what was just applied now shows as already in the app
    } catch (e) { R.busy = false; R.err = e.message; renderReconcile(); }
  } }, summary.length ? `Apply: ${summary.join(' · ')}` : 'Nothing to apply yet');

  const tile = (cls, label, amt, sub) => h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-lbl' }, label), h('div', { class: 'tile-amt' }, typeof amt === 'number' ? inr(amt) : amt), h('div', { class: 'tile-sub' }, sub));
  app.replaceChildren(...parts,
    h('div', { class: 'tiles rec-tiles' },
      tile('t-pay', 'Paid — in the statement', total(O.matched), `${O.matched.length} payment(s) matched`),
      tile('t-rec', 'Received — in the statement', total(I.matched), `${I.matched.length} receipt(s) matched`),
      // (money out and money in apart: added together they mean nothing)
      tile('t-fin', 'Not in the app', `${O.notIn.length} out · ${I.notIn.length} in`, `−${inr(total(O.notIn))} out · +${inr(total(I.notIn))} in`),
      tile('t-bal', 'Left out', total(O.leftOut, 'outstanding') + total(I.leftOut, 'outstanding'), `${O.leftOut.length} payment(s) · ${I.leftOut.length} receipt(s) not in it`)),
    ...[everything].filter(Boolean),
    matchedSec(O), matchedSec(I), leftSec(O), ...[I.leftOut.length > 0 && leftSec(I), notInSec(O), notInSec(I), doneSec].filter(Boolean), balSec,
    h('div', { class: 'card rec-apply' }, applyBtn, h('p', { class: 'muted small' }, 'Only what is listed on the button changes. It is recorded in the Activity Log.')));
}

const txDesc = (r) => r.note || (r.emi ? 'EMI' : r.category) || '';
function historyTableEl(rows) {
  if (!rows.length) return h('p', { class: 'empty' }, 'No money received or paid in this period.');
  const inSum = rows.filter((r) => r.kind === 'IN').reduce((s, r) => s + r.amount, 0), outSum = rows.filter((r) => r.kind === 'OUT').reduce((s, r) => s + r.amount, 0);
  return h('div', { class: 'scroll' }, h('table', { class: 'tx' },
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Party / description'), h('th', {}, 'Bank account'), h('th', {}, 'Bank ref.'), h('th', {}, 'Invoice / bill'), h('th', { class: 'num' }, 'Amount'))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { class: 'nowrap tx-id' }, txId(r)),
      h('td', { class: 'nowrap' }, nice(r.date)),
      h('td', {}, h('span', { class: `chip ${r.kind === 'IN' ? 'c-green' : 'c-red'}` }, r.kind === 'IN' ? 'Received' : 'Paid')),
      h('td', {}, h('strong', {}, r.name), txDesc(r) && h('div', { class: 'muted small' }, txDesc(r))),
      h('td', {}, r.bank_name, h('div', { class: 'muted small' }, `${r.bank_label} XXXX${r.last4}`)),
      h('td', { class: 'nowrap' }, r.bank_ref),
      h('td', {}, r.doc_ref || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'num' }, h('strong', {}, money(r.kind === 'IN' ? r.amount : -r.amount, r.kind === 'IN' ? 'pos' : '')))))),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: '7' }, 'Received ', money(inSum, 'pos'), ' · Paid ', money(outSum, 'red')), h('td', { class: 'num' }, money(inSum - outSum))))));
}

function recordsTableEl(rows, bankOpts) {
  if (!rows.length) return h('p', { class: 'empty' }, 'Nothing matches these filters.');
  return h('div', { class: 'scroll' }, h('table', { class: 'tx' },
    h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Party / description'), h('th', {}, 'Bank account'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Settled'), h('th', { class: 'num' }, 'Outstanding'), h('th', {}, 'Status'), can('editor') && h('th', {}, ''))),
    h('tbody', {}, rows.map((r) => {
      const open = r.state === 'pending' || r.state === 'partial', left = r.amount - r.settled, out = r.kind === 'OUT';
      return h('tr', { class: r.state === 'cancelled' ? 'inactive' : '' },
        h('td', { class: 'nowrap tx-id' }, recId(r)),
        h('td', { class: 'nowrap' }, nice(r.date)),
        h('td', {}, h('span', { class: `chip ${out ? 'c-red' : 'c-green'}` }, out ? 'Payment' : 'Receipt')),
        h('td', {}, h('strong', {}, r.name), h('div', { class: 'muted small' }, [r.ref, txDesc(r), r.bank_refs && `bank ref. ${r.bank_refs}`].filter(Boolean).join(' · '))),
        h('td', {}, r.bank_name ?? h('span', { class: 'muted' }, 'Not decided')),
        h('td', { class: 'num' }, money(r.amount)),
        h('td', { class: 'num' }, r.settled ? money(r.settled, out ? 'red' : 'pos') : '—'),
        h('td', { class: 'num' }, open ? money(left, 'amber') : '—'),
        h('td', {}, h('span', { class: `chip ${STATE_TONE[r.state]}` }, stateLabel(r)), r.last_date && r.state !== 'pending' && h('div', { class: 'muted small' }, `last ${nice(r.last_date)}`)),
        can('editor') && h('td', { class: 'acts-cell' }, open && [
          h('button', { class: `small ${out ? 'solid-red' : 'solid-green'}`, onclick: () => settleDialog({ kind: r.kind, id: r.id, name: r.name, amount: left, bankId: r.bank_id }, bankOpts) }, out ? 'Mark paid' : 'Mark received'),
          h('button', { class: 'small', onclick: () => { if (confirm(`Cancel “${r.name}”? ${r.settled ? 'What was already settled stays in the balances; the rest' : 'It'} will no longer be expected.`)) act(`/api/${out ? 'payments' : 'receipts'}/${r.id}/cancel`, {}); } }, 'Cancel')],
          can('admin') && !r.emi && h('button', { class: 'small danger', title: 'Delete it completely', onclick: () => deleteRecord(r) }, 'Delete')));
    }))));
}

// deletes a receipt or payment; money already received / paid on it leaves the balances too
function deleteRecord(r) {
  const out = r.kind === 'OUT', what = out ? 'payment' : 'receipt';
  const msg = `Delete the ${what} “${r.name}” for ${inr(r.amount)} (${recId(r)})?\n\n`
    + (r.settled ? `The ${inr(r.settled)} already ${out ? 'paid' : 'received'} on it is removed too, so the bank balance changes by that amount.\n\n` : '')
    + 'This can’t be undone. It is recorded in the Activity Log.';
  if (confirm(msg)) act(`/api/${out ? 'payments' : 'receipts'}/${r.id}/delete`, {});
}

function txDialog(kind, accounts) {
  const out = kind === 'OUT';
  if (!accounts.length) return alert('Add a bank account first (Banks → “+ Add bank account”).');
  // many at once: from an Excel sheet, as yet to be paid / received
  const fromExcel = h('div', { class: 'from-excel' },
    h('span', {}, out ? 'Many payments in an Excel sheet?' : 'Many receipts in an Excel sheet?'),
    h('button', { type: 'button', class: 'small primary', onclick: () => { dlg.close(); uploadDialog(kind); } }, '⇪ Add from Excel'));
  openDialog(out ? 'Record a payment' : 'Record a receipt', [
    { name: out ? 'payee' : 'party', label: out ? 'Paid to' : 'Received from', required: true },
    { name: 'amount', label: 'Amount (₹)', type: 'money', required: true },
    { name: 'status', label: 'Status', type: 'select', value: 'completed', options: [['completed', out ? 'Paid — the money has left the bank' : 'Received — the money is in the bank'], ['pending', out ? 'Yet to be paid (balances not affected)' : 'Yet to be received (balances not affected)']] },
    { name: 'date', label: 'Date', type: 'date', value: S.today, required: true, hint: 'For a received / paid item, the date it went through the bank (today or earlier). For a pending one, the date it is due.' },
    { name: 'bank_id', label: 'Bank account', type: 'bank', value: accounts[0]?.id, options: [...accounts.map((b) => [b.id, `${b.name} — ${b.bank} XXXX${b.last4}`]), ['', 'Not decided yet (pending only)']], required: false },
    { name: 'bank_ref', label: 'Bank reference (UTR / cheque no.)', hint: 'Needed when it is received or paid. The same reference can’t be used twice on one account.' },
    ...(out ? [{ name: 'category', label: 'Category', type: 'select', options: CATEGORIES.map((c) => [c, c]), required: true }] : []),
    { name: 'ref', label: out ? 'Invoice / bill no. (optional)' : 'Invoice no. (optional)' },
    { name: 'note', label: 'Description (optional)' },
    ...(out && can('admin') ? [{ name: 'approved', label: 'Approved', type: 'checkbox', value: true }] : []),
  ], out ? 'Record payment' : 'Record receipt', (v) => confirmDup((dup) => api('/api/transactions', { ...v, kind, confirmDuplicate: dup })), fromExcel);
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

// ── Banks: each account's day — opening balance, debits, credits, closing balance, and its EMIs ──
async function loadBanks() {
  const d = await api(`/api/banks/day?date=${S.bday || S.today}`);
  S.bday = d.date;
  renderBanks(d);
}

function renderBanks(d) {
  const T = d.total, isToday = d.date === d.today;
  const day = (n) => { S.bday = addDays(d.date, n); load(); };
  const picker = h('div', { class: 'card toolbar' }, h('div', { class: 'bar' },
    h('button', { class: 'small', onclick: () => day(-1), 'aria-label': 'Previous day' }, '‹ Previous day'),
    h('input', { type: 'date', value: d.date, max: d.today, 'aria-label': 'Day', onchange: (e) => { if (e.target.value) { S.bday = e.target.value > d.today ? d.today : e.target.value; load(); } } }),
    h('button', { class: 'small', disabled: isToday, onclick: () => day(1), 'aria-label': 'Next day' }, 'Next day ›'),
    !isToday && h('button', { class: 'small', onclick: () => { S.bday = d.today; load(); } }, 'Today')));

  const tile = (cls, label, p, sub) => h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-lbl' }, label), h('div', { class: `tile-amt ${p < 0 ? 'neg' : ''}` }, inr(p)), sub && h('div', { class: 'tile-sub' }, sub));
  const n = (k) => d.banks.reduce((m, b) => m + b[k].length, 0);
  const summary = h('header', { class: 'hero' },
    h('div', { class: 'hero-top' }, h('div', {}, h('div', { class: 'eyebrow' }, isToday ? `Today · ${nice(d.date)}` : nice(d.date)), h('h1', {}, 'All banks for the day'))),
    h('div', { class: 'tiles' },
      tile('t-bal', 'Opening balance', T.opening, 'At the start of the day'),
      tile('t-pay', '− Debits', T.paid, `${n('debits')} payment(s) out`),
      tile('t-rec', '+ Credits', T.received, `${n('credits')} receipt(s) in`),
      tile('t-fin', isToday ? '= Closing balance (so far)' : '= Closing balance', T.closing, T.corrections ? `Includes balance corrections ${inr(T.corrections)}` : isToday ? 'So far today' : 'At the end of the day')),
    (T.emiDue > 0 || T.reserved > 0) && h('div', { class: 'hold-strip' }, h('span', { class: 'badge-emi' }, 'EMI'),
      h('span', {}, T.emiDue ? [h('strong', {}, inr(T.emiDue)), ' of EMIs due on this day. '] : '', isToday && T.reserved ? [h('strong', {}, inr(T.reserved)), ' reserved for EMIs in this app now.'] : '')));

  // search: the accounts whose name, bank or last 4 digits have every word typed (here, as you type — no reload)
  const q = (S.bq ?? '').trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
  const shown = d.banks.filter((b) => words.every((w) => `${b.name} ${b.bank}`.toLowerCase().includes(w)));
  const setQ = (v) => { S.bq = v; keepFocus(() => renderBanks(d)); };
  const search = d.banks.length > 0 && h('div', { class: 'card toolbar bank-search', role: 'search' },
    h('input', { type: 'search', name: 'bq', class: 'search', placeholder: 'Search bank accounts — name, bank or last 4 digits', value: S.bq ?? '', 'aria-label': 'Search bank accounts', oninput: (e) => setQ(e.target.value) }),
    q && h('span', { class: 'muted small result-count' }, `${shown.length} of ${d.banks.length} bank account${d.banks.length === 1 ? '' : 's'}`),
    q && h('button', { class: 'small', 'aria-label': 'Clear search', onclick: () => setQ('') }, '✕ Clear'));
  const sum = (k) => shown.reduce((m, b) => m + b[k], 0);
  const F = q ? { label: `Matching (${shown.length})`, opening: sum('opening'), paid: sum('paid'), received: sum('received'), closing: sum('closing'), emiDue: shown.reduce((m, b) => m + b.emisDue.reduce((n, e) => n + e.amount, 0), 0) }
    : { label: 'All banks', ...T };

  const table = shown.length > 0 && h('section', { class: 'card' }, h('h2', {}, h('span', { class: 'dot d-blue' }), `Bank-wise · ${nice(d.date)}`),
    h('div', { class: 'scroll' }, h('table', { class: 'tx' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Bank account'), h('th', { class: 'num' }, 'Opening'), h('th', { class: 'num' }, '− Debits'), h('th', { class: 'num' }, '+ Credits'), h('th', { class: 'num' }, '= Closing'), h('th', {}, 'EMI'))),
      h('tbody', {}, shown.map((b) => h('tr', {},
        h('td', {}, h('strong', {}, b.name), h('div', { class: 'muted small' }, b.bank)),
        h('td', { class: 'num' }, money(b.opening)), h('td', { class: 'num' }, money(b.paid, b.paid ? 'red' : '')), h('td', { class: 'num' }, money(b.received, b.received ? 'pos' : '')),
        h('td', { class: 'num' }, h('strong', {}, money(b.closing))),
        h('td', {}, emiSummary(b, isToday))))),
      h('tfoot', {}, h('tr', {}, h('td', {}, F.label), h('td', { class: 'num' }, money(F.opening)), h('td', { class: 'num' }, money(F.paid, 'red')), h('td', { class: 'num' }, money(F.received, 'pos')), h('td', { class: 'num' }, money(F.closing)), h('td', {}, F.emiDue ? `${inr(F.emiDue)} due` : '—'))))));

  const line = (label, p, cls = '') => h('div', { class: 'bc-line' }, h('span', { class: 'muted' }, label), money(p, cls));
  const moves = (list, out) => list.length
    ? h('ul', { class: 'day-moves' }, list.map((m) => h('li', {}, h('span', {}, m.name, m.note && h('span', { class: 'muted small' }, ` · ${m.note}`), h('span', { class: 'muted small' }, ` · ${m.ref}`)), money(out ? -m.amount : m.amount, out ? '' : 'pos'))))
    : h('div', { class: 'muted small day-none' }, out ? 'No debits' : 'No credits');
  const cards = d.banks.length && !shown.length
    ? h('div', { class: 'card' }, h('p', { class: 'empty' }, `No bank account matches “${S.bq.trim()}”. `, h('button', { class: 'link', onclick: () => setQ('') }, 'Show all bank accounts')))
    : d.banks.length
    ? h('div', { class: 'bank-cards' }, shown.map((b) => h('section', { class: `bank-card ${b.closing < 0 ? 'short' : ''}` },
      h('div', { class: 'bc-head' }, h('div', {}, h('strong', {}, b.name), h('div', { class: 'muted small' }, b.bank)),
        h('div', { class: 'bc-acts' },
          !b.balanceEntered && h('span', { class: 'chip c-amber', title: 'Enter a bank balance on the Dashboard so this starts from the right figure.' }, 'no balance entered'),
          can('admin') && h('button', { class: 'small danger', 'aria-label': `Delete ${b.name}`, onclick: () => bankDeleteDialog(b) }, 'Delete'))),
      h('div', { class: `bc-amt ${b.closing < 0 ? 'neg' : ''}` }, inr(b.closing)),
      h('div', { class: 'muted small bc-cap' }, isToday ? 'closing balance so far today' : 'closing balance'),
      line('Opening balance', b.opening),
      line(`− Debits (${b.debits.length})`, b.paid, 'red'), moves(b.debits, true),
      line(`+ Credits (${b.credits.length})`, b.received, 'pos'), moves(b.credits, false),
      b.corrections !== 0 && line('± Balance correction', b.corrections, 'amber'),
      h('div', { class: 'bc-line total' }, h('span', {}, '= Closing balance'), money(b.closing)),
      h('div', { class: 'bc-emi' }, h('strong', {}, 'EMI'), emiDetail(b, isToday))))
    )
    : h('div', { class: 'card' }, h('p', { class: 'empty' }, can('admin') ? 'No bank accounts yet — add your first one with “+ Add bank account” above.' : 'No bank accounts yet.'));

  app.replaceChildren(...[topBar(), pageHead('Banks', 'Each bank account for a day: opening balance, debits, credits, closing balance, and EMIs.',
    can('admin') && h('button', { class: 'primary', onclick: bankDialog }, '+ Add bank account'),
    can('admin') && h('button', { onclick: () => bankUploadDialog() }, '⇪ Upload Excel')), flash(), search, picker, summary, table, cards].filter(Boolean));
}
const EMI_STATE_SHORT = { paid: ['paid', 'c-green'], overdue: ['unpaid', 'c-red'], due: ['due today', 'c-amber'], upcoming: ['upcoming', 'c-blue'], scheduled: ['scheduled', ''] };
// the EMI column: what is due that day, else the next one
function emiSummary(b, isToday) {
  if (b.emisDue.length) return h('div', { class: 'chips' }, b.emisDue.map((e) => h('span', { class: `chip ${EMI_STATE_SHORT[e.state]?.[1] ?? ''}` }, `${e.lender} ${inr(e.amount)} · ${EMI_STATE_SHORT[e.state]?.[0] ?? e.state}`)));
  if (b.nextEmi) return h('span', { class: 'muted small' }, `Next: ${b.nextEmi.lender} ${inr(b.nextEmi.amount)} on ${nice(b.nextEmi.due_date)}${isToday && b.reserved ? ` · ${inr(b.reserved)} reserved` : ''}`);
  return h('span', { class: 'muted small' }, '—');
}
function emiDetail(b, isToday) {
  return h('div', {},
    b.emisDue.length
      ? b.emisDue.map((e) => h('div', { class: 'bc-line' }, h('span', {}, `${e.lender} (due this day)`, ' ', h('span', { class: `chip ${EMI_STATE_SHORT[e.state]?.[1] ?? ''}` }, e.state === 'paid' && e.paid_on ? `paid ${nice(e.paid_on)}` : EMI_STATE_SHORT[e.state]?.[0] ?? e.state)), money(e.amount, 'amber')))
      : h('div', { class: 'muted small' }, 'No EMI due on this day.'),
    isToday && b.reserved > 0 && h('div', { class: 'bc-line' }, h('span', { class: 'muted' }, 'Reserved for EMIs now (in this app)'), money(b.reserved, 'amber')),
    b.nextEmi && h('div', { class: 'muted small' }, `Next EMI: ${b.nextEmi.lender} ${inr(b.nextEmi.amount)} on ${nice(b.nextEmi.due_date)}`));
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
        bankPicker({ label: 'Account', options: [['', 'All accounts'], ...ov.accounts.map((a) => [String(a.id), `${a.name} — ${a.bank}`])], value: f.bank, onchange: (v) => { S.ef = { ...S.ef, bank: v }; load(); } }))),
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
  if (!bankOpts.length) return alert('Add a bank account first (Banks → “+ Add bank account”).');
  openDialog('Add an EMI', [
    { name: 'lender', label: 'Lender / loan', placeholder: 'e.g. HDFC car loan', required: true },
    { name: 'amount', label: 'EMI amount (₹)', type: 'money', required: true },
    { name: 'bank_id', label: 'Paid from account', type: 'bank', value: bankOpts[0]?.[0], options: bankOpts, required: true },
    { name: 'start_date', label: 'Next EMI date', type: 'date', min: addDays(S.today, -31), required: true, hint: 'It repeats on this day every month (the last day in shorter months).' },
    { name: 'end_date', label: 'Last EMI date (optional)', type: 'date' },
    { name: 'ref', label: 'Loan account no. (optional)' },
    ...reminderFields(null),
  ], 'Add EMI', (v) => confirmDup((dup) => api('/api/emis', { ...reminderBody(v), confirmDuplicate: dup })), null, true);
}

function emiSettingsDialog(e) {
  openDialog(`Settings: ${e.lender}`, reminderFields(e), 'Save', (v) => api(`/api/emis/${e.id}`, reminderBody(v)), `${inr(e.amount)} from ${e.bank_name}, every month on day ${e.day}.`);
}

// ── shared page pieces ──
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const pageHead = (title, sub, ...actions) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub && h('div', { class: 'muted' }, sub)), h('div', { class: 'bar' }, actions));
// keep the cursor in a search box when its page re-renders
const keepFocus = (render) => {
  const a = document.activeElement, name = a?.name, pos = a?.selectionStart;
  render();
  const n = name && app.querySelector(`input[name="${name}"]`);
  if (n && a?.tagName === 'INPUT' && a.type === 'search') { n.focus(); n.setSelectionRange(pos, pos); }
};
let searchTimer;
const onSearch = (apply) => (e) => { clearTimeout(searchTimer); const v = e.target.value; searchTimer = setTimeout(() => { apply(v); load(); }, 250); };

// ── Users: everyone who can sign in. Admins add them with an email (their login ID) and a password ──
const ROLE = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
const ROLE_OPTS = [['viewer', 'Viewer — can look, can’t change anything'], ['editor', 'Editor — adds and updates records'], ['admin', 'Admin — everything, including users']];

async function loadUsers() {
  const { users } = await api('/api/users');
  renderUsers(users);
}

function renderUsers(users) {
  const active = users.filter((u) => u.active).length;
  const table = users.length && h('div', { class: 'scroll' }, h('table', { class: 'tx users' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email (login ID)'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}, 'Last sign-in'), h('th', {}, ''))),
    h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
      h('td', {}, h('strong', {}, u.name), u.id === S.user.id && h('span', { class: 'chip c-blue' }, 'you')),
      h('td', {}, u.email),
      h('td', {}, h('span', { class: `chip ${u.role === 'admin' ? 'c-violet' : u.role === 'editor' ? 'c-green' : ''}` }, ROLE[u.role])),
      h('td', {}, h('span', { class: `chip ${u.active ? 'c-green' : 'c-red'}` }, u.active ? 'Can sign in' : 'Access removed')),
      h('td', { class: 'nowrap muted small' }, u.last_login ? when(u.last_login) : 'Never'),
      h('td', { class: 'acts-cell' }, ...userButtons(u)))))));
  app.replaceChildren(topBar(),
    pageHead('Users', `${active} ${active === 1 ? 'person' : 'people'} can sign in. Each signs in with their email and the password you set.`,
      h('button', { class: 'primary', onclick: userForm }, '+ Add user')),
    h('section', { class: 'card' }, table || h('p', { class: 'empty' }, 'No users yet.')));
}

function userButtons(u) {
  const del = u.id !== S.user.id && h('button', { class: 'small c-red', onclick: () => deleteUserDialog(u) }, 'Delete');
  if (!u.active) return [h('button', { class: 'small', onclick: () => act(`/api/users/${u.id}/access`, { active: true }) }, 'Restore access'), del].filter(Boolean);
  const me = u.id === S.user.id;
  return [
    h('button', { class: 'small', onclick: () => editUserDialog(u) }, 'Edit'),
    !me && h('button', { class: 'small', onclick: () => roleDialog(u) }, 'Change role'),
    !me && h('button', { class: 'small', onclick: () => setPasswordDialog(u) }, 'Set password'),
    !me && h('button', { class: 'small', onclick: () => { if (confirm(`Remove ${u.name}’s access? They are signed out everywhere and can’t sign in until you restore it. Their history stays.`)) act(`/api/users/${u.id}/access`, { active: false }); } }, 'Remove access'),
    del,
  ].filter(Boolean);
}

const passwordFields = (label) => [
  { name: 'password', label, type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with letters and numbers. Give it to them privately.' },
  { name: 'confirm', label: 'Password again', type: 'password', required: true, autocomplete: 'new-password' },
];
function userForm() {
  openDialog('Add a user', [
    { name: 'name', label: 'Full name', required: true },
    { name: 'email', label: 'Email — this is their login ID', type: 'email', required: true },
    { name: 'role', label: 'What can they do?', type: 'select', value: 'viewer', options: ROLE_OPTS },
    ...passwordFields('Password'),
  ], 'Add user', async (v) => {
    if (v.password !== v.confirm) throw new Error('The two passwords don’t match.');
    await api('/api/users', { name: v.name, email: v.email, role: v.role, password: v.password });
    setTimeout(() => alert(`${v.name} can now sign in with ${v.email.trim().toLowerCase()} and the password you set. Give them the password privately.`), 0);
  });
}
function editUserDialog(u) {
  openDialog(`Edit ${u.name}`, [
    { name: 'name', label: 'Full name', value: u.name, required: true },
    { name: 'email', label: 'Email — their login ID', type: 'email', value: u.email, required: true, hint: 'If you change it, they sign in with the new email from now on.' },
  ], 'Save', (v) => api(`/api/users/${u.id}`, v));
}
function setPasswordDialog(u) {
  openDialog(`Set a new password for ${u.name}`, passwordFields('New password'), 'Set password', async (v) => {
    if (v.password !== v.confirm) throw new Error('The two passwords don’t match.');
    await api(`/api/users/${u.id}/password`, { password: v.password });
    setTimeout(() => alert(`Done. ${u.name} is signed out everywhere and now signs in with the new password.`), 0);
  }, `For ${u.email}. They are signed out everywhere and use this password from now on.`);
}
// deleting can't be undone, so the admin types the person's name to confirm
function deleteUserDialog(u) {
  openDialog(`Delete ${u.name}?`, [
    { name: 'confirm', label: `Type ${u.name} to confirm`, required: true, autocomplete: 'off' },
  ], 'Delete user', async (v) => {
    if (v.confirm.trim() !== u.name.trim()) throw new Error(`Type the name exactly as shown: ${u.name}`);
    await api(`/api/users/${u.id}/delete`, {});
  }, `${u.name} (${u.email}) will be signed out and can never sign in again, and leaves this list. This can’t be undone — to stop someone for now, use “Remove access” instead. What they recorded stays, under their name.`);
}
function roleDialog(u) {
  openDialog(`Change ${u.name}’s role`, [
    { name: 'role', label: 'What can they do?', type: 'select', value: u.role, options: ROLE_OPTS },
  ], 'Save', (v) => api(`/api/users/${u.id}/role`, v), 'It applies the next time they open a page; they don’t need to sign in again.');
}

function passwordDialog() {
  openDialog('Change your password', [
    { name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
    { name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with letters and numbers.' },
    { name: 'confirm', label: 'New password again', type: 'password', required: true, autocomplete: 'new-password' },
  ], 'Change password', async (v) => {
    if (v.password !== v.confirm) throw new Error('The two new passwords don’t match.');
    await api('/api/me/password', { current: v.current, password: v.password });
    setTimeout(() => alert('Your password is changed. You stay signed in here; other devices are signed out.'), 0);
  });
}

// ── Activity log (admins) ──
const ACTION_LABELS = {
  'emi.edit': 'Changed EMI settings', 'emi.reminders': 'Checked EMI reminders',
  'report.export': 'Exported a report',
  login: 'Signed in', 'login.failed': 'Failed sign-in', 'login.locked': 'Locked out (too many wrong passwords)', logout: 'Signed out',
  setup: 'Set up the app (first admin)', 'admin.create': 'Admin account created (script)', 'user.add': 'Added a user', 'user.edit': 'Edited a user', 'user.role': 'Changed a user’s role', 'user.password': 'Set a user’s password',
  'user.remove': 'Removed a user’s access', 'user.delete': 'Deleted a user', 'user.restore': 'Restored a user’s access', 'account.create': 'Created a login', 'account.password': 'Set someone’s password',
  'invite.create': 'Invited someone to the app', 'invite.reset_link': 'Made a password reset link', 'invite.cancel': 'Cancelled an invite link',
  'invite.accept': 'Accepted an invite (set their password)', 'password.reset': 'Set a new password from a reset link', 'password.change': 'Changed their password',
  'signup.request': 'Asked to sign up', 'access.role': 'Changed someone’s role',
  'access.remove': 'Removed someone’s access', 'access.restore': 'Restored someone’s access',
  'person.add': 'Added a person', 'person.edit': 'Edited a person', 'person.activate': 'Activated a person', 'person.deactivate': 'Deactivated a person', 'person.assign': 'Assigned a position',
  'position.add': 'Added a position', 'position.edit': 'Edited a position', 'position.activate': 'Activated a position', 'position.deactivate': 'Deactivated a position',
  'payment.add': 'Added a payment', 'payment.paid': 'Marked a payment paid', 'payment.approve': 'Approved a payment', 'payment.cancel': 'Cancelled a payment',
  'receipt.add': 'Added a receipt', 'receipt.received': 'Marked a receipt received', 'receipt.cancel': 'Cancelled a receipt',
  'import.add': 'Uploaded payments / receipts from a sheet', 'emi.add': 'Added an EMI', 'emi.stop': 'Stopped an EMI', 'balance.add': 'Entered a bank balance', 'bank.add': 'Added a bank account', 'bank.delete': 'Deleted a bank account', 'bank.import': 'Uploaded bank accounts from a sheet', 'reconcile.apply': 'Reconciled a bank statement', 'reconcile.ai_read': 'Had a statement read by AI', 'reconcile.docsumo_read': 'Had a statement read by Docsumo', 'payment.reschedule': 'Moved a payment’s due date', 'payment.delete': 'Deleted a payment', 'receipt.delete': 'Deleted a receipt',
};
const actionTone = (a) => (/failed|locked/.test(a) ? 'c-red' : /^(login|logout|setup|admin)/.test(a) ? 'c-blue' : /^(person|position|user)/.test(a) ? 'c-violet' : /cancel|deactivate|stop|delete/.test(a) ? 'c-red' : 'c-amber');
// a short, readable summary of what was recorded
function describe(a, positions) {
  const d = a.detail || {}, out = [];
  const fmt = (k, v) => (v == null || v === '' ? '—' : k === 'position_id' ? positions.get(v) ?? `#${v}` : /amount/i.test(k) && typeof v === 'number' ? inr(v) : String(v));
  if (a.action === 'emi.reminders') return `${d.reminders ?? 0} due · ${d.inApp ?? 0} in-app · ${d.queued ?? 0} email(s) queued · ${d.sent ?? 0} sent${d.via ? ' · daily schedule' : ''}`;
  if (a.action === 'signup.request') return `${d.email} · ${!d.matched ? 'not in People (nothing sent)' : d.emailed === 'sent' ? `link emailed (${d.role})` : d.emailed === 'not set up' ? 'email not set up: admins notified' : `email ${d.emailed}`}`;
  if (a.action === 'reconcile.ai_read') return `${d.file || 'statement'} · ${d.lines} line(s) read · ${d.model}`;
  if (a.action === 'reconcile.docsumo_read') return `${d.file || 'statement'} · ${d.lines} line(s) read by Docsumo`;
  if (a.action === 'reconcile.apply') return [`${d.bank} · ${d.from} to ${d.to}`, d.paid && `${d.paid} paid ${inr(d.paidAmount)}`, d.recorded && `${d.recorded} recorded as new`, d.received && `${d.received} received ${inr(d.receivedAmount)}`, d.recordedIn && `${d.recordedIn} receipt(s) recorded as new`,
    (d.assigned || d.assignedIn) && `${(d.assigned || 0) + (d.assignedIn || 0)} with no account put in ${d.bank}`, d.today && `${d.today} to today`, d.tomorrow && `${d.tomorrow} to next day`, d.cancelled && `${d.cancelled} cancelled`, d.balanceSaved && 'balance saved'].filter(Boolean).join(' · ');
  if (a.action === 'payment.reschedule') return `${d.payee} · ${inr(d.amount)} · ${d.from} → ${d.to}`;
  if (a.action === 'bank.import') return `${d.file || 'sheet'} · ${d.added} added${d.balances ? ` (${d.balances} with an opening balance)` : ''}${d.skipped ? ` · ${d.skipped} skipped` : ''}`;
  if (a.action === 'bank.delete') return [`${d.name} (${d.bank} XXXX${d.last4})`, d.entries && `${d.entries} transaction(s) deleted`, d.receivedAmount && `${inr(d.receivedAmount)} in`, d.paidAmount && `${inr(d.paidAmount)} out`, d.emis && `${d.emis} EMI(s)`, d.balances && `${d.balances} balance(s)`, d.nowNotDecided && `${d.nowNotDecided} now “Not decided”`].filter(Boolean).join(' · ');
  if (a.action === 'payment.delete' || a.action === 'receipt.delete') return [d.payee || d.party, inr(d.amount), d.date, d.ref, d.settled && `incl. ${inr(d.settled)} ${a.action === 'payment.delete' ? 'paid' : 'received'}`].filter(Boolean).join(' · ');
  if (a.action === 'import.add') return `${d.file || 'sheet'} · ${d.added} added (${d.payments} to pay${d.paymentAmount ? ` ${inr(d.paymentAmount)}` : ''}, ${d.receipts} to receive${d.receiptAmount ? ` ${inr(d.receiptAmount)}` : ''})${d.skipped ? ` · ${d.skipped} skipped` : ''}`;
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
    api(`/api/activity?${p}`), more ? S.act.users : api('/api/users').then((x) => x.users), new Map(),
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
        h('td', {}, a.user_name ? h('span', {}, a.user_name, a.user_deleted && h('span', { class: 'muted small' }, ' (deleted)'), h('div', { class: 'muted small' }, a.user_role)) : h('span', { class: 'muted' }, 'Not signed in')),
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
