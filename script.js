/* ==============================================================
   CLIENT APP — talks to the database via gs() below, which is
   defined in db.js (Supabase-backed) and loaded before this file.
================================================================= */

const state = {
  user: null,
  batches: [], closedBatches: [], subjects: [], students: [], discontinued: [],
  instituteName: 'Unacademy Class Attendance', defaulterThreshold: 75,
  view: 'home'
};

/* ================= CACHE (stale-while-revalidate) =================
   Every gsSWR call shows cached data instantly (if any), then quietly
   fetches the live version in the background and calls onData again
   when it arrives — so switching pages feels instant even though the
   real data is still coming from Sheets/Apps Script underneath. */

const CACHE_PREFIX = 'attmgr:';

function getCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setCache(key, data) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data)); } catch (e) { /* storage full/unavailable — fine, just skip caching */ }
}

/** cacheKey: string. fnName/args: what to call via gs(). onData(data, isFresh) fires
 *  once immediately with cached data (if present), and again when the live call returns. */
function gsSWR(cacheKey, fnName, args, onData) {
  const cached = getCache(cacheKey);
  if (cached) onData(cached, false);
  gs.apply(null, [fnName].concat(args)).then(function (fresh) {
    setCache(cacheKey, fresh);
    onData(fresh, true);
  }).catch(function (e) {
    if (!cached) toast(e.message || String(e), 'error');
  });
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, 3200);
}

/** Puts a button into a disabled/spinner state while fn() runs, so a slow
 *  request can't be double-clicked into firing twice, and the person can see
 *  something is happening. fn() may return a promise or nothing (e.g. it bailed
 *  out on a validation error) — either way the button resets itself after. */
function runWithLoading(btn, loadingText, fn) {
  if (!btn) return fn();
  const isLink = btn.tagName === 'A';
  const originalText = btn.textContent;
  if (isLink) { btn.classList.add('link-disabled'); } else { btn.disabled = true; btn.classList.add('btn-loading'); }
  btn.textContent = loadingText;
  const reset = function () {
    if (!btn) return;
    if (isLink) { btn.classList.remove('link-disabled'); } else { btn.disabled = false; btn.classList.remove('btn-loading'); }
    btn.textContent = originalText;
  };
  const result = fn();
  if (result && typeof result.then === 'function') {
    result.then(reset, reset);
  } else {
    reset();
  }
  return result;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
}); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Dates are stored/sent as yyyy-mm-dd (what <input type="date"> needs); this is
 *  only for what people actually read on screen and in exports. */
function fmtDate(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return isoDate;
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : isoDate;
}


/* ================= PERMISSIONS & ROLES ================= */

const PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'mark', label: 'Mark Attendance' },
  { key: 'records', label: 'Records (view)' },
  { key: 'calling', label: 'Absentees Calling sheet' },
  { key: 'reports', label: 'Reports' },
  { key: 'students', label: 'Students page (view list)' },
  { key: 'student_add', label: 'Add student', parent: 'students' },
  { key: 'student_edit', label: 'Edit student', parent: 'students' },
  { key: 'student_discontinue', label: 'Discontinue / Restore student', parent: 'students' },
  { key: 'student_delete', label: 'Delete student', parent: 'students' },
  { key: 'batches', label: 'Batches (add, edit, close, restore)' },
  { key: 'subjects', label: 'Subjects (add, edit)' },
  { key: 'bulk_import', label: 'Bulk import (students & attendance history)' }
];
/* Roles: Teacher and Admin are fixed. Anything else is a custom role name typed by the admin
   (e.g. "Tele Caller") — the role name is just a label, what a login can do comes from its ticked access. */
const ROLES = ['Teacher', 'Admin'];
/** Pre-ticked access for a role while creating a login — the admin can still tick/untick anything. */
const ROLE_PRESETS = {
  'Teacher': ['dashboard', 'mark', 'records', 'calling', 'reports'],
  'Admin': PERMISSIONS.map(function (p) { return p.key; })
};
const CUSTOM_ROLE_DEFAULT = ['dashboard', 'records'];

function normalizeUser(u) {
  const user = Object.assign({}, u);
  user.assignedBatchIds = user.assignedBatchIds || [];
  if (user.role === 'Admin') user.permissions = ROLE_PRESETS['Admin'].slice();
  else if (!Array.isArray(user.permissions)) user.permissions = (ROLE_PRESETS[user.role] || CUSTOM_ROLE_DEFAULT).slice();
  return user;
}
function isAdmin() { return !!state.user && state.user.role === 'Admin'; }
function hasPerm(p) { return isAdmin() || (!!state.user && (state.user.permissions || []).indexOf(p) !== -1); }

function batchNameAny(id) {
  const b = state.batches.concat(state.closedBatches || []).find(function (x) { return x.ID === id; });
  return b ? b.Name + (b.Closed ? ' (Closed)' : '') : '(unassigned)';
}

/** Open batches this person can work with (marking, calling). */
function myBatches() {
  if (isAdmin()) return state.batches;
  return state.batches.filter(function (b) { return state.user.assignedBatchIds.indexOf(b.ID) !== -1; });
}
/** For filters on Records / Reports — closed batches stay selectable so history is still reachable. */
function filterBatches() {
  const all = state.batches.concat(state.closedBatches || []);
  if (isAdmin()) return all;
  return all.filter(function (b) { return state.user.assignedBatchIds.indexOf(b.ID) !== -1; });
}
/** Active + discontinued students this person may look up. */
function visibleStudents() {
  const all = state.students.concat(state.discontinued || []);
  if (isAdmin()) return all;
  return all.filter(function (s) { return state.user.assignedBatchIds.indexOf(s.BatchID) !== -1; });
}

/* ================= LOGIN & SAVED SESSION ================= */

const SESSION_KEY = CACHE_PREFIX + 'session';
const VIEW_KEY = CACHE_PREFIX + 'view';
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // stay signed in for 30 days

function saveSession_(user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ user: user, savedAt: Date.now() })); } catch (e) { /* private mode — just won't persist */ }
}
function loadSavedSession_() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !s.user || !s.user.id || Date.now() - s.savedAt > SESSION_MAX_AGE_MS) return null;
    return s;
  } catch (e) { return null; }
}

function renderLogin() {
  document.getElementById('app').innerHTML =
    '<div class="login-wrap"><div class="login-card">' +
      '<h1>' + esc(state.instituteName) + '</h1>' +
      '<p class="sub">Sign in to manage attendance</p>' +
      '<div id="loginError" class="error-text"></div>' +
      '<div class="field"><label>Username</label><input id="loginUser" autocapitalize="off" autocomplete="username" autofocus></div>' +
      '<div class="field"><label>Password</label><input id="loginPass" type="password" autocomplete="current-password"></div>' +
      '<button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">Sign in</button>' +
    '</div></div>';
  document.getElementById('loginPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
}

function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!username || !password) return;
  gs('login', username, password).then(function (res) {
    if (res.error) { document.getElementById('loginError').textContent = res.error; return; }
    state.user = normalizeUser(res);
    saveSession_(state.user);
    try { localStorage.removeItem(VIEW_KEY); } catch (e) { }
    boot();
  }).catch(function (e) { document.getElementById('loginError').textContent = e.message || String(e); });
}

function logout() {
  try {
    Object.keys(localStorage).filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; }).forEach(function (k) { localStorage.removeItem(k); });
  } catch (e) { }
  state.user = null;
  renderLogin();
}

/** Page refresh: go straight back in with the saved login, then quietly re-check it with the database. */
function restoreSession() {
  const saved = loadSavedSession_();
  if (!saved) { renderLogin(); return; }
  state.user = normalizeUser(saved.user);
  document.getElementById('app').innerHTML = '<div class="login-wrap"><div class="login-card" style="text-align:center"><h1>' + esc(state.instituteName) + '</h1><p class="sub" style="margin:0">Loading…</p></div></div>';
  boot();
  gs('getSessionUser', saved.user.id).then(function (res) {
    if (!state.user) return;
    if (res && res.error) { toast(res.error, 'error'); logout(); return; }
    if (res && res.id) {
      const before = JSON.stringify([state.user.role, state.user.permissions, state.user.assignedBatchIds]);
      state.user = normalizeUser(res);
      saveSession_(state.user);
      if (before !== JSON.stringify([state.user.role, state.user.permissions, state.user.assignedBatchIds]) && !document.querySelector('.modal-overlay')) renderShell();
    }
  }).catch(function () { /* offline or old database — keep the saved login */ });
}

/* ================= BOOT + SHELL ================= */

function applyBootstrap(data) {
  state.batches = data.batches || [];
  state.closedBatches = data.closedBatches || [];
  state.subjects = data.subjects || [];
  state.students = data.students || [];
  state.discontinued = data.discontinued || [];
}

function boot() {
  let v = null;
  try { v = localStorage.getItem(VIEW_KEY); } catch (e) { }
  state.view = (v && canSeeNavId(v)) ? v : firstAllowedView();
  gsSWR('bootstrap', 'getBootstrapData', [], function (data) {
    applyBootstrap(data);
    state.instituteName = data.instituteName;
    state.defaulterThreshold = data.defaulterThreshold;
    if (!state.user) return;
    if (!document.querySelector('.modal-overlay')) renderShell();
  });
}

function refreshData() {
  return gs('getBootstrapData').then(function (data) {
    applyBootstrap(data);
    setCache('bootstrap', Object.assign({}, getCache('bootstrap') || {}, data));
  });
}

const NAV = [
  { id: 'home', label: 'Dashboard', perm: 'dashboard' },
  { id: 'mark', label: 'Mark Attendance', perm: 'mark' },
  { id: 'records', label: 'Records', perm: 'records' },
  { id: 'calling', label: 'Absentees Calling', perm: 'calling' },
  { id: 'reports', label: 'Reports', perm: 'reports' },
  { id: 'batches', label: 'Batches', perm: 'batches' },
  { id: 'subjects', label: 'Subjects', perm: 'subjects' },
  { id: 'students', label: 'Students', perm: 'students' },
  { id: 'discontinued', label: 'Discontinued Students', perm: 'student_discontinue' },
  { id: 'teachers', label: 'Staff Logins', perm: '__admin' },
  { id: 'activity', label: 'Activity Log', perm: '__admin' },
  { id: 'settings', label: 'Settings', perm: '__admin' }
];
function canSeeNav(n) { return n.perm === '__admin' ? isAdmin() : hasPerm(n.perm); }
function canSeeNavId(id) { const n = NAV.find(function (x) { return x.id === id; }); return !!n && canSeeNav(n); }
function firstAllowedView() { const n = NAV.find(canSeeNav); return n ? n.id : 'home'; }

function renderShell() {
  const navHtml = NAV.filter(canSeeNav).map(function (n) {
    return '<div class="nav-item' + (state.view === n.id ? ' active' : '') + '" onclick="setView(\'' + n.id + '\')">' + n.label + '</div>';
  }).join('');

  document.body.classList.remove('menu-open');
  document.getElementById('app').innerHTML =
    '<div class="menu-backdrop" id="menuBackdrop" onclick="closeMenu()"></div>' +
    '<aside class="sidebar" id="sidebar">' +
      '<div class="sidebar-head"><div class="brand">' + esc(state.instituteName) + '</div>' +
        '<button type="button" class="menu-close" onclick="closeMenu()" aria-label="Close menu">&times;</button></div>' +
      '<nav class="nav-list">' + navHtml + '</nav>' +
      '<div class="sidebar-footer"><div class="who">' + esc(state.user.name) + ' &middot; ' + esc(state.user.role) + '</div>' +
        '<a class="link" onclick="closeMenu();openChangePassword()">Change password</a>' +
        '<a class="link" onclick="logout()">Sign out</a></div>' +
    '</aside>' +
    '<div class="main">' +
      '<header class="topbar"><h2 id="viewTitle"></h2>' +
        '<div class="topbar-actions"><a class="link topbar-pw" onclick="openChangePassword()">Change password</a>' +
        '<button type="button" class="menu-btn" onclick="openMenu()" aria-label="Open menu"><span></span><span></span><span></span></button></div>' +
      '</header>' +
      '<div class="content" id="content"></div>' +
    '</div>';
  renderView();
}

function openMenu() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('menuBackdrop').classList.add('open');
  document.body.classList.add('menu-open');
}
function closeMenu() {
  const sb_ = document.getElementById('sidebar'), bd = document.getElementById('menuBackdrop');
  if (sb_) sb_.classList.remove('open');
  if (bd) bd.classList.remove('open');
  document.body.classList.remove('menu-open');
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

function setView(v) {
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch (e) { }
  window.scrollTo(0, 0);
  renderShell();
}

function renderView() {
  const titles = { home: 'Dashboard', mark: 'Mark Attendance', records: 'Attendance Records', calling: 'Absentees Calling Sheet', reports: 'Reports',
    batches: 'Batches', subjects: 'Subjects', students: 'Students', discontinued: 'Discontinued Students', teachers: 'Staff Logins', activity: 'Activity Log', settings: 'Settings' };
  if (!canSeeNavId(state.view)) state.view = firstAllowedView();
  document.getElementById('viewTitle').textContent = titles[state.view] || '';
  if (!NAV.some(canSeeNav)) { document.getElementById('content').innerHTML = '<div class="empty-state">No access has been given to this login yet. Ask your admin.</div>'; return; }
  const renderers = { home: renderHome, mark: renderMark, records: renderRecords, calling: renderCalling, reports: renderReports,
    batches: renderBatches, subjects: renderSubjects, students: renderStudents, discontinued: renderDiscontinued, teachers: renderTeachers, activity: renderActivity, settings: renderSettings };
  (renderers[state.view] || renderHome)();
}

/* ================= HOME ================= */

function renderHome() {
  const content = document.getElementById('content');
  const cached = getCache('defaulters');
  if (!cached) content.innerHTML = '<div class="empty-state">Loading…</div>';
  gsSWR('defaulters', 'getDefaultersReport', [{}], function (defaulters) {
    if (state.view !== 'home') return; // user already navigated away
    const ids = myBatches().map(function (b) { return b.ID; });
    defaulters = defaulters.filter(function (d) { return !d.discontinued && (!d.batchId || ids.indexOf(d.batchId) !== -1); });
    const students = state.students.filter(function (s) { return ids.indexOf(s.BatchID) !== -1; });
    const subjects = state.subjects.filter(function (s) { return ids.indexOf(s.BatchID) !== -1; });
    content.innerHTML =
      '<div class="stat-grid">' +
        statCard(ids.length, 'Batches') +
        statCard(students.length, 'Active students') +
        statCard(subjects.length, 'Subjects') +
        statCard(defaulters.length, 'Students below ' + state.defaulterThreshold + '% attendance') +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><h3>Below-threshold students</h3>' + (hasPerm('reports') ? '<a class="link" onclick="setView(\'reports\')">Full reports →</a>' : '') + '</div>' +
        (defaulters.length ? renderTable(['Student', 'Roll No', 'Sessions', 'Present', '%'],
          defaulters.slice(0, 8).map(function (d) { return [esc(d.studentName), esc(d.rollNo), d.totalSessions, d.present, badgePct(d.percentage)]; }))
          : '<div class="empty-state">No defaulters — nice work 🎉</div>') +
      '</div>';
  });
}

/* ================= STUDENT SEARCH PICKER =================
   Type the first letters of a name (or roll no / phone) and matching students appear straight away —
   names starting with what you typed come first. With opts.multi you can pick several students
   (e.g. the same person who moved between batches) and they show as removable chips. */

function byId(id) { return document.getElementById(id); }

const PICKERS = {};

function studentPickerHtml(id, placeholder, multi) {
  return '<div class="picker' + (multi ? ' picker-multi' : '') + '" id="' + id + 'Wrap">' +
    (multi ? '<div class="picker-chips" id="' + id + 'Chips"></div>' : '') +
    '<input type="text" id="' + id + 'Input" class="picker-input" placeholder="' + esc(placeholder || 'Type student name…') + '" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    '<button type="button" class="picker-clear" id="' + id + 'Clear" title="Clear" aria-label="Clear">&times;</button>' +
    (multi ? '<div class="picker-hint" id="' + id + 'Hint"></div>' : '') +
    '<input type="hidden" id="' + id + '" value="">' +
    '<div class="picker-list" id="' + id + 'List"></div></div>';
}

function contactNums_(s) {
  return (s.Contacts || []).map(function (c) { return c.number; }).concat([s.Phone, s.ParentPhone]).join(' ');
}

function searchStudents_(pool, q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  pool.forEach(function (s) {
    const name = String(s.Name || '').toLowerCase().replace(/\s+/g, ' ');
    const roll = String(s.RollNo || '').toLowerCase();
    let score = -1;
    if (name.indexOf(q) === 0) score = 0;
    else if (name.split(' ').some(function (w) { return w.indexOf(q) === 0; })) score = 1;
    else if (roll.indexOf(q) === 0) score = 2;
    else if (name.indexOf(q) !== -1) score = 3;
    else if (roll.indexOf(q) !== -1 || contactNums_(s).indexOf(q) !== -1) score = 4;
    if (score >= 0) out.push({ s: s, score: score, name: name });
  });
  out.sort(function (a, b) { return a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  return out.slice(0, 40).map(function (x) { return x.s; });
}

/** opts.getStudents() → students to search; opts.onChange(id) (single) or opts.onChange([ids]) (multi). */
function initStudentPicker(id, opts) {
  const multi = !!opts.multi;
  const input = byId(id + 'Input'), hidden = byId(id), list = byId(id + 'List'), clearBtn = byId(id + 'Clear');
  const chipsEl = byId(id + 'Chips'), hintEl = byId(id + 'Hint');
  if (!input) return;
  let items = [], active = -1, label = '', selected = [];
  const labelOf = function (s) { return s.Name + (s.RollNo ? ' (' + s.RollNo + ')' : ''); };
  const fire = function () { if (opts.onChange) opts.onChange(multi ? selected.map(function (s) { return s.ID; }) : hidden.value); };

  function close() { list.style.display = 'none'; active = -1; }
  function show() {
    if (!input.value.trim()) { close(); return; }
    items = searchStudents_(opts.getStudents(), input.value).filter(function (s) { return !selected.some(function (x) { return x.ID === s.ID; }); });
    list.innerHTML = items.length
      ? items.map(function (s, i) {
          return '<div class="picker-item" data-i="' + i + '"><span class="pi-name">' + esc(s.Name) + '</span>' +
            '<span class="pi-meta">' + esc([s.RollNo, batchNameAny(s.BatchID), s.Discontinued ? 'Discontinued' : ''].filter(Boolean).join(' · ')) + '</span></div>';
        }).join('')
      : '<div class="picker-empty">No student found</div>';
    list.style.display = 'block';
    active = -1;
  }
  function highlight() {
    Array.prototype.forEach.call(list.querySelectorAll('.picker-item'), function (el, i) {
      el.classList.toggle('active', i === active);
      if (i === active) el.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ----- multi: chips + "same name in another batch" hint ----- */
  function renderChips() {
    chipsEl.innerHTML = selected.map(function (s) {
      return '<span class="chip"><span><b>' + esc(s.Name) + '</b>' + (s.RollNo ? ' (' + esc(s.RollNo) + ')' : '') + ' · ' + esc(batchNameAny(s.BatchID)) + '</span>' +
        '<button type="button" class="chip-x" data-remove="' + s.ID + '" aria-label="Remove">&times;</button></span>';
    }).join('');
    hidden.value = selected.map(function (s) { return s.ID; }).join(',');
    clearBtn.style.display = selected.length ? 'block' : 'none';
    // someone with the very same name in another batch is probably the same person
    const names = selected.map(function (s) { return String(s.Name || '').trim().toLowerCase(); });
    const twins = opts.getStudents().filter(function (s) {
      return names.indexOf(String(s.Name || '').trim().toLowerCase()) !== -1 && !selected.some(function (x) { return x.ID === s.ID; });
    });
    hintEl.innerHTML = twins.length
      ? '<span class="muted">Same name in another batch — add:</span> ' + twins.slice(0, 6).map(function (s) {
          return '<button type="button" class="chip-add" data-add="' + s.ID + '">+ ' + esc(labelOf(s)) + ' · ' + esc(batchNameAny(s.BatchID)) + '</button>';
        }).join(' ')
      : '';
  }
  function addSelected(s) {
    if (!s || selected.some(function (x) { return x.ID === s.ID; })) return;
    selected.push(s);
    renderChips();
    fire();
  }

  function choose(i) {
    const s = items[i];
    if (!s) return;
    if (multi) { input.value = ''; close(); addSelected(s); return; }
    hidden.value = s.ID;
    label = labelOf(s);
    input.value = label;
    clearBtn.style.display = 'block';
    close();
    fire();
  }
  function clear(doFire) {
    const had = multi ? selected.length > 0 : !!hidden.value;
    selected = []; hidden.value = ''; input.value = ''; label = '';
    if (multi) renderChips();
    clearBtn.style.display = 'none';
    close();
    if (had && doFire) fire();
  }

  input.addEventListener('input', function () {
    if (!multi && hidden.value && input.value !== label) { hidden.value = ''; fire(); }
    if (!multi) clearBtn.style.display = input.value ? 'block' : 'none';
    show();
  });
  input.addEventListener('focus', function () { if (input.value && (multi || !hidden.value)) show(); else if (!multi) input.select(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.style.display !== 'block') show(); active = Math.min(active + 1, items.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') { if (list.style.display === 'block') { e.preventDefault(); choose(active >= 0 ? active : 0); } }
    else if (e.key === 'Escape') { close(); }
    else if (e.key === 'Backspace' && multi && !input.value && selected.length) { selected.pop(); renderChips(); fire(); }
  });
  input.addEventListener('blur', function () {
    setTimeout(function () {
      close();
      if (input.value && (multi || !hidden.value)) { input.value = ''; if (!multi) clearBtn.style.display = 'none'; }
    }, 180);
  });
  list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus so the click below lands
  list.addEventListener('click', function (e) {
    const el = e.target.closest('.picker-item');
    if (el) choose(Number(el.getAttribute('data-i')));
  });
  if (multi) {
    chipsEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      selected = selected.filter(function (s) { return s.ID !== b.getAttribute('data-remove'); });
      renderChips(); fire();
    });
    hintEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-add]');
      if (!b) return;
      addSelected(opts.getStudents().find(function (s) { return s.ID === b.getAttribute('data-add'); }));
    });
  }
  clearBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  clearBtn.addEventListener('click', function () { clear(true); input.focus(); });
  clearBtn.style.display = 'none';

  PICKERS[id] = {
    clear: function () { clear(false); },
    setSelected: function (students) {
      if (multi) { selected = []; students.forEach(function (s) { selected.push(s); }); renderChips(); }
      else if (students[0]) { hidden.value = students[0].ID; label = labelOf(students[0]); input.value = label; clearBtn.style.display = 'block'; }
    }
  };
}

function setStudentPicker(id, student) { if (PICKERS[id]) PICKERS[id].setSelected([student]); }
function clearStudentPicker(id) { if (PICKERS[id]) PICKERS[id].clear(); }

function statCard(num, label) {
  return '<div class="stat-card"><div class="num">' + esc(num) + '</div><div class="label">' + esc(label) + '</div></div>';
}
function badgePct(p) {
  const cls = p >= 75 ? 'badge-success' : (p >= 50 ? 'badge-warn' : 'badge-danger');
  return '<span class="badge ' + cls + '">' + p + '%</span>';
}
function renderTable(headers, rows) {
  return '<div class="table-scroll"><table><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + rows.map(function (row) {
      return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}

/* ================= MARK ATTENDANCE ================= */

let sessionCtx = null; // what is on screen: batch / subject / date plus the marks loaded from the database
let sessionToken = 0;  // so a slow answer for an old selection can't overwrite a newer one

function renderMark() {
  const batches = myBatches();
  const content = document.getElementById('content');
  sessionCtx = null;
  if (!batches.length) { content.innerHTML = '<div class="empty-state">You are not assigned to any batch yet. Ask your admin to assign one.</div>'; return; }

  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="markBatch" onchange="onMarkBatchChange(); loadSession()">' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>Subject</label><select id="markSubject" onchange="loadSession()"></select></div>' +
        '<div class="field"><label>Date</label><input type="date" id="markDate" value="' + todayStr() + '" onchange="loadSession()"></div>' +
        '<div class="field"><button class="btn btn-secondary" onclick="loadSession(this)">Reload</button></div>' +
      '</div>' +
    '</div>' +
    '<div id="sessionArea"></div>';
  onMarkBatchChange();
  loadSession();
  syncHighlights();
}

function onMarkBatchChange() {
  const batchId = document.getElementById('markBatch').value;
  const subjects = state.subjects.filter(function (s) { return s.BatchID === batchId; });
  const sel = document.getElementById('markSubject');
  sel.innerHTML = '<option value="__ALL__">All Subjects</option>' + subjects.map(function (s) { return '<option value="' + s.ID + '">' + esc(s.Name) + '</option>'; }).join('');
  sel.value = '__ALL__';
}

function subjectNameById_(id) { const s = state.subjects.find(function (x) { return x.ID === id; }); return s ? s.Name : '?'; }

/** Works out what is already saved so the screen shows it (e.g. attendance that came from a bulk upload). */
function buildSessionContext_(batchId, subjectId, date, isAll, rows, offRows) {
  const subjectIds = state.subjects.filter(function (s) { return s.BatchID === batchId; }).map(function (s) { return s.ID; });
  const ctx = { batchId: batchId, subjectId: subjectId, date: date, isAll: isAll, subjectIds: subjectIds, bySubject: {}, orig: {}, notes: {}, hasExisting: false, off: {}, offType: null, offRemark: '', offNote: '' };
  const per = {};
  rows.forEach(function (r) {
    if (isAll && subjectIds.indexOf(r.SubjectID) === -1) return;
    ctx.hasExisting = true;
    (ctx.bySubject[r.SubjectID] = ctx.bySubject[r.SubjectID] || {})[r.StudentID] = r.Status;
    (per[r.StudentID] = per[r.StudentID] || []).push({ sid: r.SubjectID, status: r.Status });
  });
  (offRows || []).forEach(function (r) { ctx.off[r.SubjectID] = r; });
  const slots = isAll ? subjectIds : [subjectId];
  const offSlots = slots.filter(function (sid) { return ctx.off[sid]; });
  if (slots.length && offSlots.length === slots.length && !ctx.hasExisting) {
    ctx.offType = ctx.off[offSlots[0]].Type;
    ctx.offRemark = ctx.off[offSlots[0]].Remark || '';
  } else if (offSlots.length) {
    ctx.offNote = offSlots.map(function (sid) { return subjectNameById_(sid) + ' (' + ctx.off[sid].Type + (ctx.off[sid].Remark ? ': ' + ctx.off[sid].Remark : '') + ')'; }).join(', ');
  }
  Object.keys(per).forEach(function (stu) {
    const list = per[stu];
    const has = function (st) { return list.some(function (x) { return x.status === st; }); };
    ctx.orig[stu] = has('Absent') ? 'Absent' : has('Late') ? 'Late' : 'Present';
    const distinct = {};
    list.forEach(function (x) { distinct[x.status] = 1; });
    if (isAll && Object.keys(distinct).length > 1) {
      const parts = [];
      ['Absent', 'Late'].forEach(function (st) {
        const names = list.filter(function (x) { return x.status === st; }).map(function (x) { return subjectNameById_(x.sid); });
        if (names.length) parts.push(st + ': ' + names.join(', '));
      });
      ctx.notes[stu] = parts.join(' · ');
    }
  });
  return ctx;
}

function loadSession(btn) {
  const batchId = document.getElementById('markBatch').value;
  const subjectId = document.getElementById('markSubject').value;
  const date = document.getElementById('markDate').value;
  if (!subjectId || !date) { if (btn) toast('Pick a subject and date first', 'error'); return; }

  const area = document.getElementById('sessionArea');
  const token = ++sessionToken;
  sessionCtx = null;

  const isAll = subjectId === '__ALL__';
  area.innerHTML = '<div class="empty-state">Loading attendance…</div>';
  const load = Promise.all([
    isAll ? gs('getBatchDayAttendance', batchId, date) : gs('getSessionAttendance', batchId, subjectId, date),
    gs('getClassOff', batchId, date).catch(function () { return []; })
  ]);
  const task = load.then(function (res) {
    if (token !== sessionToken) return; // a newer selection took over
    const roster = rosterFor_(batchId, date, res[0].map(function (r) { return r.StudentID; }));
    if (!roster.length) { area.innerHTML = '<div class="empty-state">No students in this batch' + (date ? ' on ' + fmtDate(date) : '') + '.</div>'; return; }
    sessionCtx = buildSessionContext_(batchId, subjectId, date, isAll, res[0], res[1]);
    renderMarkRoster(sessionCtx, roster);
  }).catch(function (e) {
    if (token === sessionToken) { area.innerHTML = '<div class="empty-state">Could not load attendance.</div>'; toast(e.message || String(e), 'error'); }
  });
  if (btn) runWithLoading(btn, 'Loading…', function () { return task; });
}

/** Who belongs on this batch's sheet for this date: today's students, plus anyone who was here on that date
 *  (moved to another batch later / discontinued later) or who already has a mark saved here. */
function rosterFor_(batchId, date, markedIds) {
  const marked = {};
  (markedIds || []).forEach(function (id) { marked[id] = true; });
  return state.students.concat(state.discontinued || []).filter(function (s) {
    const here = s.BatchID === batchId && !s.Discontinued && (!s.BatchSince || date >= s.BatchSince);
    const wasHere = (s.BatchHistory || []).some(function (h) { return h.batchId === batchId && (!h.from || date >= h.from) && date < h.to; });
    const leftLater = s.Discontinued && s.BatchID === batchId && s.DiscontinuedAt && date < s.DiscontinuedAt && (!s.BatchSince || date >= s.BatchSince);
    return here || wasHere || leftLater || marked[s.ID];
  }).sort(function (a, b) { return String(a.Name).toLowerCase() < String(b.Name).toLowerCase() ? -1 : 1; });
}

function renderMarkRoster(ctx, roster) {
  const rows = roster.map(function (s) {
    const status = ctx.orig[s.ID] || ''; // nothing is assumed — unmarked stays unmarked
    const searchBlob = (s.Name + ' ' + (s.RollNo || '') + ' ' + (s.Phone || '')).toLowerCase();
    return '<div class="attendance-row' + (status ? '' : ' unmarked') + (s.Highlighted ? ' hl-on' : '') + '" data-student="' + s.ID + '" data-search="' + esc(searchBlob) + '">' +
      '<div>' + esc(s.Name) + (s.RollNo ? ' <span class="muted">(' + esc(s.RollNo) + ')</span>' : '') +
        (s.Discontinued ? '<div class="tag-note">Discontinued' + (s.DiscontinuedAt ? ' on ' + fmtDate(s.DiscontinuedAt) : '') + '</div>'
          : s.BatchID !== ctx.batchId ? '<div class="tag-note">Now in ' + esc(batchNameAny(s.BatchID)) + '</div>' : '') +
        (ctx.notes[s.ID] ? '<div class="muted" style="font-size:12px">' + esc(ctx.notes[s.ID]) + '</div>' : '') + highlightBlock_(s) + '</div>' +
      '<div class="status-toggle">' +
        ['Present', 'Absent', 'Late'].map(function (st) {
          return '<button type="button" class="status-btn' + (status === st ? ' selected ' + st.toLowerCase() : '') +
            '" onclick="setStatus(this,\'' + st + '\')" data-status="' + st + '">' + st + '</button>';
        }).join('') +
      '</div></div>';
  }).join('');

  const heading = ctx.isAll ? roster.length + ' students — ALL subjects' : roster.length + ' students';
  let banner;
  if (ctx.hasExisting) {
    banner = ctx.isAll
      ? 'Showing attendance already saved for ' + fmtDate(ctx.date) + ' (including bulk-uploaded data). Anyone absent in any subject shows as Absent. Change a student here and it applies to every subject held that day; students you don\'t touch keep their own per-subject marks.'
      : 'Showing attendance already saved for this subject on ' + fmtDate(ctx.date) + '.';
  } else {
    banner = 'Nothing saved yet for ' + fmtDate(ctx.date) + '. Mark each student, or use Quick actions (All present / All absent / Holiday / Class cancelled / No class).';
  }
  if (ctx.offNote) banner += ' Not held: ' + ctx.offNote + '.';

  document.getElementById('sessionArea').innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>' + heading + '</h3>' +
        '<div class="quick-wrap"><span class="mark-count" id="markCount"></span>' +
          '<select id="quickAction" class="quick-select" onchange="onQuickAction(this.value)">' +
            '<option value="">Quick actions…</option>' +
            '<option value="Present">All present</option><option value="Absent">All absent</option>' +
            '<optgroup label="Whole day off"><option value="Holiday">Holiday</option><option value="Class Cancelled">Class cancelled</option><option value="No Class">No class</option></optgroup>' +
          '</select></div></div>' +
      '<p class="muted" style="margin:-8px 0 14px">' + esc(banner) + '</p>' +
      '<div id="offPanel" class="off-panel" style="display:none">' +
        '<div class="off-title" id="offTitle"></div>' +
        '<p class="muted" style="margin:4px 0 12px">No attendance is counted for this day, so nobody is marked absent and percentages are not affected.</p>' +
        '<div class="field"><label>Remark / reason</label><input id="offRemark" placeholder="e.g. Diwali holiday, teacher on leave" value="' + esc(ctx.offRemark) + '"></div>' +
      '</div>' +
      '<div id="rosterBlock">' +
        '<div class="field" style="max-width:320px"><input type="text" id="rosterSearch" placeholder="Search by name, roll no, or phone…" oninput="filterRoster()"></div>' +
        '<div id="rosterList">' + rows + '</div>' +
        '<div id="rosterEmpty" class="empty-state" style="display:none">No students match your search.</div>' +
      '</div>' +
      '<div style="margin-top:16px;text-align:right"><button class="btn btn-primary" onclick="saveSession(this)">Save</button></div>' +
    '</div>';
  applyOffUi();
  updateMarkCount();
}

/** Switches the screen between the student list and the Holiday / Cancelled / No class panel. */
function applyOffUi() {
  const ctx = sessionCtx;
  if (!ctx) return;
  const off = !!ctx.offType;
  byId('rosterBlock').style.display = off ? 'none' : '';
  byId('offPanel').style.display = off ? 'block' : 'none';
  byId('markCount').style.display = off ? 'none' : '';
  byId('quickAction').value = off ? ctx.offType : '';
  if (off) byId('offTitle').textContent = (ctx.isAll ? 'Whole day' : 'This class') + ' marked as: ' + ctx.offType;
}
function onQuickAction(v) {
  const ctx = sessionCtx;
  if (!ctx || !v) return;
  if (v === 'Present' || v === 'Absent') {
    ctx.offType = null;
    applyOffUi();
    markAll(v);
    byId('quickAction').value = '';
  } else {
    ctx.offType = v;
    applyOffUi();
    byId('offRemark').focus();
  }
}
function updateMarkCount() {
  const rows = document.querySelectorAll('.attendance-row');
  const marked = document.querySelectorAll('.attendance-row .status-btn.selected').length;
  const el = byId('markCount');
  if (el) { el.textContent = 'Marked ' + marked + ' / ' + rows.length; el.classList.toggle('incomplete', marked < rows.length); }
}

function setStatus(btn, status) {
  const group = btn.parentElement;
  Array.prototype.forEach.call(group.children, function (b) { b.classList.remove('selected', 'present', 'absent', 'late'); });
  btn.classList.add('selected', status.toLowerCase());
  const row = btn.closest('.attendance-row');
  if (row) row.classList.remove('unmarked');
  if (byId('markCount')) updateMarkCount();
}
function markAll(status) {
  document.querySelectorAll('.attendance-row').forEach(function (row) {
    setStatus(row.querySelector('[data-status="' + status + '"]'), status);
  });
}

/** Just shows/hides rows — never touches their selected status, so searching
 *  never loses marks already set on hidden students. */
function filterRoster() {
  const q = (document.getElementById('rosterSearch').value || '').trim().toLowerCase();
  let visibleCount = 0;
  document.querySelectorAll('.attendance-row').forEach(function (row) {
    const match = !q || (row.getAttribute('data-search') || '').indexOf(q) !== -1;
    row.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  document.getElementById('rosterEmpty').style.display = visibleCount ? 'none' : 'block';
}

function saveSession(btn) {
  const ctx = sessionCtx; // always saves what was loaded, never whatever the filters were changed to afterwards
  if (!ctx) { toast('Load a session first', 'error'); return; }
  if (ctx.offType) { saveOffDay(btn, ctx); return; }

  const cur = {};
  let firstUnmarked = null, unmarkedCount = 0;
  document.querySelectorAll('.attendance-row').forEach(function (row) {
    const selected = row.querySelector('.status-btn.selected');
    if (!selected) { unmarkedCount++; if (!firstUnmarked) firstUnmarked = row; return; }
    cur[row.getAttribute('data-student')] = selected.getAttribute('data-status');
  });
  if (unmarkedCount) {
    byId('rosterSearch').value = ''; filterRoster();
    firstUnmarked.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(unmarkedCount + ' student(s) not marked yet — mark everyone, or use Quick actions', 'error');
    return;
  }
  const studentIds = Object.keys(cur);

  let targets;
  if (!ctx.isAll) targets = [ctx.subjectId];
  else if (!ctx.hasExisting) targets = ctx.subjectIds.filter(function (sid) { return !ctx.off[sid]; }); // fresh day — every subject that isn't off
  else targets = ctx.subjectIds.filter(function (sid) { return ctx.bySubject[sid] && Object.keys(ctx.bySubject[sid]).length; }); // only classes that were actually held
  if (!targets.length) { toast('This batch has no subjects yet — add one from Subjects first', 'error'); return; }

  const task = Promise.all(targets.map(function (sid) {
    const records = studentIds.map(function (stu) {
      let status = cur[stu];
      if (ctx.isAll && ctx.hasExisting && ctx.orig[stu] === cur[stu]) {
        const prev = (ctx.bySubject[sid] || {})[stu];
        if (prev) status = prev; // untouched student → keep their individual mark for this subject
      }
      return { studentId: stu, status: status };
    });
    return gs('submitAttendance', state.user, ctx.date, ctx.batchId, sid, records);
  })).then(function () {
    clearAttendanceCaches();
    toast('Attendance saved for ' + studentIds.length + ' students' + (ctx.isAll ? ' across ' + targets.length + ' subject(s)' : ''), 'success');
    loadSession();
  }).catch(function (e) { toast(e.message || String(e), 'error'); });

  if (btn) runWithLoading(btn, 'Saving…', function () { return task; });
}

function saveOffDay(btn, ctx) {
  const remark = (byId('offRemark').value || '').trim();
  const targets = ctx.isAll ? ctx.subjectIds : [ctx.subjectId];
  if (ctx.hasExisting && !confirm('Attendance already saved for ' + fmtDate(ctx.date) + ' will be deleted and the day marked as "' + ctx.offType + '". Continue?')) return;
  const task = gs('setClassOff', state.user, ctx.date, ctx.batchId, targets, ctx.offType, remark).then(function () {
    clearAttendanceCaches();
    toast('Marked as ' + ctx.offType, 'success');
    loadSession();
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
  if (btn) runWithLoading(btn, 'Saving…', function () { return task; });
}


/** Attendance changed — any cached records/reports/home numbers are now stale. */
function clearAttendanceCaches() {
  try {
    Object.keys(localStorage)
      .filter(function (k) { return k.indexOf(CACHE_PREFIX + 'records:') === 0 || k.indexOf(CACHE_PREFIX + 'report:') === 0 || k === CACHE_PREFIX + 'defaulters'; })
      .forEach(function (k) { localStorage.removeItem(k); });
  } catch (e) { /* fine, worst case a stale view shows briefly */ }
}

/* ================= RECORDS ================= */

function renderRecords() {
  const batches = filterBatches();
  const content = document.getElementById('content');
  content.innerHTML =
    (hasPerm('bulk_import')
      ? '<div class="card-header" style="margin-bottom:0"><div></div><button class="btn btn-secondary btn-sm" onclick="openBulkImportAttendance()">Bulk import attendance (CSV)</button></div>'
      : '') +
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="recBatch" onchange="clearStudentPicker(\'recStudent\')"><option value="">All</option>' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>Student</label>' + studentPickerHtml('recStudent', 'All students — type a name…') + '</div>' +
        '<div class="field"><label>From</label><input type="date" id="recFrom"></div>' +
        '<div class="field"><label>To</label><input type="date" id="recTo"></div>' +
        '<div class="field"><button class="btn btn-primary" onclick="loadRecords()">Filter</button></div>' +
      '</div>' +
      '<div class="flex-between"><div id="recCount" class="muted"></div>' +
        exportRowHtml() +
      '</div>' +
      '<div id="recTable" style="margin-top:12px"></div>' +
    '</div>';
  initStudentPicker('recStudent', {
    getStudents: function () {
      const b = byId('recBatch').value;
      return visibleStudents().filter(function (s) { return !b || s.BatchID === b; });
    },
    onChange: function () { loadRecords(); }
  });
  loadRecords();
}

function exportRowHtml() {
  if (!isAdmin()) return ''; // exports are for the admin only
  return '<div class="export-row">' +
    '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'csv\')">Export CSV</button>' +
    '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'xlsx\')">Export Excel</button>' +
    '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'pdf\')">Export PDF</button></div>';
}

let lastExportData = null; // { title, headers, rows, loadAll? } — loadAll fetches every matching row for export

const RECORDS_PAGE_SIZE = 500;
const RECORD_EXPORT_HEADERS = ['Date', 'Batch', 'Subject', 'Student', 'Roll No', 'Status', 'Marked By', 'Remark', 'Reason'];
function recordToExportRow(r) { return [fmtDate(r.date), r.batchName, r.subjectName, r.studentName, r.rollNo, r.status, r.markedBy, r.remark, r.reason]; }

function loadRecords() {
  const filters = {
    batchId: document.getElementById('recBatch').value,
    studentId: document.getElementById('recStudent').value,
    from: document.getElementById('recFrom').value,
    to: document.getElementById('recTo').value
  };
  // Teachers only ever see their own batches, even with "All" selected.
  if (!isAdmin() && !filters.batchId) filters.batchIds = filterBatches().map(function (b) { return b.ID; });

  const cacheKey = 'records:' + JSON.stringify(filters);
  if (!getCache(cacheKey)) document.getElementById('recTable').innerHTML = '<div class="empty-state">Loading…</div>';
  gsSWR(cacheKey, 'getAttendanceRecordsPage', [filters, RECORDS_PAGE_SIZE], function (res) {
    if (state.view !== 'records') return;
    const records = res.records, total = res.total;
    document.getElementById('recCount').textContent = total.toLocaleString() + ' record(s)' +
      (total > records.length ? ' — showing the latest ' + records.length.toLocaleString() + '. Narrow the filters to see others; Export includes all ' + total.toLocaleString() + '.' : '');
    lastExportData = {
      title: 'Attendance_Records', headers: RECORD_EXPORT_HEADERS,
      rows: records.map(recordToExportRow),
      loadAll: total > records.length
        ? function () { return gs('getAttendanceRecords', filters).then(function (all) { return all.map(recordToExportRow); }); }
        : null
    };
    document.getElementById('recTable').innerHTML = records.length ? renderRecordsTable(records) : '<div class="empty-state">No records match these filters.</div>';
  });
}

/** Read-only — rows just pick up a light tint if they were color-flagged from the
 *  Absentee Calling page, so you can see follow-up status at a glance here too. */
function renderRecordsTable(records) {
  const head = ['Date', 'Batch', 'Subject', 'Student', 'Roll No', 'Status', 'Marked By', 'Remark'];
  const rowsHtml = records.map(function (r) {
    const cells = [fmtDate(r.date), esc(r.batchName), esc(r.subjectName), esc(r.studentName), esc(r.rollNo),
      statusBadge(r.status), esc(r.markedBy), r.remark ? esc(r.remark) : '<span class="muted">—</span>'];
    const rowClass = r.color ? ' class="row-' + esc(r.color) + '"' : '';
    return '<tr' + rowClass + '>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="table-scroll"><table><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div>';
}

function pickSwatch(btn) {
  const group = btn.parentElement;
  Array.prototype.forEach.call(group.children, function (b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
}

function statusBadge(status) {
  const cls = status === 'Present' ? 'badge-success' : status === 'Late' ? 'badge-warn' : 'badge-danger';
  return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
}


/* ================= ABSENTEE CALLING ================= */

let callToken = 0;

function renderCalling() {
  const batches = myBatches();
  const content = document.getElementById('content');
  if (!batches.length) { content.innerHTML = '<div class="empty-state">No batches available.</div>'; return; }
  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="callBatch" onchange="loadAbsentees()">' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>Date</label><input type="date" id="callDate" value="' + todayStr() + '" onchange="loadAbsentees()"></div>' +
        '<div class="field"><button class="btn btn-secondary" onclick="loadAbsentees(this)">Reload</button></div>' +
      '</div>' +
    '</div>' +
    '<div id="callingArea"></div>';
  loadAbsentees();
  syncHighlights();
}

function loadAbsentees(btn) {
  const batchId = document.getElementById('callBatch').value;
  const date = document.getElementById('callDate').value;
  if (!batchId || !date) { if (btn) toast('Pick a batch and date first', 'error'); return; }
  const token = ++callToken;
  document.getElementById('callingArea').innerHTML = '<div class="empty-state">Loading…</div>';
  const task = gs('getAbsenteesForDate', batchId, date).then(function (res) {
    if (token !== callToken) return;
    renderAbsenteeList(res, batchId, date);
  }).catch(function (e) {
    if (token === callToken) { document.getElementById('callingArea').innerHTML = ''; toast(e.message || String(e), 'error'); }
  });
  if (btn) runWithLoading(btn, 'Loading…', function () { return task; });
}

function renderAbsenteeList(res, batchId, date) {
  const area = document.getElementById('callingArea');
  const absentees = res.absentees;
  if (!absentees.length) {
    area.innerHTML = res.totalMarked
      ? '<div class="empty-state">No absentees for this batch on ' + fmtDate(date) + ' 🎉</div>'
      : (res.off && res.off.length)
      ? '<div class="empty-state">' + res.off.map(function (o) { return esc(o.type) + (o.remark ? ' — ' + esc(o.remark) : ''); }).join('<br>') + '<br><span style="font-size:12.5px">No attendance for ' + fmtDate(date) + ', so there is nobody to call.</span></div>'
      : '<div class="empty-state">No attendance has been marked for this batch on ' + fmtDate(date) + '.<br>' +
        '<span style="font-size:12.5px">If you uploaded this date from a CSV, check that you picked the same batch name that was written in the CSV.</span></div>';
    return;
  }
  const colors = [
    { key: '', label: 'None' }, { key: 'red', label: 'No response' }, { key: 'yellow', label: 'Follow up' },
    { key: 'green', label: 'Informed / OK' }, { key: 'blue', label: 'Excused' }, { key: 'purple', label: 'Other' }
  ];
  area.innerHTML =
    '<div class="card"><h3 style="margin-top:0">' + absentees.length + ' absentee(s) — ' + fmtDate(date) + '</h3></div>' +
    absentees.map(function (a) {
      const uid = 'call_' + a.studentId;
      const hlStudent = studentById_(a.studentId);
      return '<div class="card' + (a.color ? ' row-' + esc(a.color) : '') + (hlStudent && hlStudent.Highlighted ? ' hl-on' : '') + '" data-student="' + a.studentId + '">' +
        '<div class="flex-between" style="margin-bottom:10px">' +
          '<div><strong>' + esc(a.name) + '</strong>' + (a.rollNo ? ' <span class="muted">(' + esc(a.rollNo) + ')</span>' : '') +
            '<div class="muted" style="font-size:12.5px">Absent: ' + esc(a.subjects.join(', ')) + '</div>' + highlightBlock_(hlStudent) + '</div>' +
          '<div class="call-numbers">' +
            (a.contacts && a.contacts.length
              ? '<div class="muted" style="font-size:11.5px;margin-bottom:2px">Call in this order</div>' + a.contacts.map(function (c, i) {
                  return '<div><strong>' + (i + 1) + '. ' + esc(c.label) + ':</strong> <a class="tel" href="tel:' + esc(c.number) + '">' + esc(c.number) + '</a></div>';
                }).join('')
              : '<span class="muted">No number on file</span>') +
          '</div>' +
        '</div>' +
        '<div class="field"><label>Remark (short)</label><input id="' + uid + '_remark" value="' + esc(a.remark) + '" placeholder="e.g. Spoke to mother, informed a day in advance"></div>' +
        '<div class="field"><label>Reason (detail)</label><textarea id="' + uid + '_reason" rows="2" placeholder="Longer note if needed">' + esc(a.reason) + '</textarea></div>' +
        '<div class="flex-between">' +
          '<div class="color-swatch-row">' +
            colors.map(function (c) {
              const selected = (a.color || '') === c.key ? ' selected' : '';
              return '<button type="button" class="color-swatch swatch-' + (c.key || 'none') + selected + '" data-color="' + c.key + '" onclick="pickSwatch(this)" title="' + c.label + '"></button>';
            }).join('') +
          '</div>' +
          '<button class="btn btn-primary btn-sm" onclick="saveAbsenteeCall(this,\'' + a.studentId + '\',\'' + uid + '\')">Save</button>' +
        '</div>' +
      '</div>';
    }).join('');

  area.querySelectorAll('[data-student]').forEach(function (card) { card.setAttribute('data-batch', batchId); card.setAttribute('data-date', date); });
}

function saveAbsenteeCall(btn, studentId, uid) {
  const card = btn.closest('[data-student]');
  const batchId = card.getAttribute('data-batch');
  const date = card.getAttribute('data-date');
  const selectedSwatch = card.querySelector('.color-swatch.selected');
  const data = {
    remark: document.getElementById(uid + '_remark').value.trim(),
    reason: document.getElementById(uid + '_reason').value.trim(),
    color: selectedSwatch ? selectedSwatch.getAttribute('data-color') : ''
  };
  const task = gs('saveAbsenteeCall', state.user.role, studentId, batchId, date, data).then(function () {
    clearAttendanceCaches();
    card.classList.remove('row-red', 'row-yellow', 'row-green', 'row-blue', 'row-purple');
    if (data.color) card.classList.add('row-' + data.color);
    toast('Saved', 'success');
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
  runWithLoading(btn, 'Saving…', function () { return task; });
}

function exportCurrent(format) {
  if (!isAdmin()) { toast('Only the admin can export', 'error'); return; }
  if (!lastExportData) { toast('Nothing to export yet', 'error'); return; }
  const data = lastExportData;
  toast(data.loadAll ? 'Collecting all rows…' : 'Preparing ' + format.toUpperCase() + '…');
  const rowsPromise = data.loadAll ? data.loadAll() : Promise.resolve(data.rows);
  rowsPromise.then(function (rows) {
    if (!rows.length) { toast('Nothing to export yet', 'error'); return; }
    if (format === 'pdf' && rows.length > 5000) {
      toast('PDF is limited to 5,000 rows (' + rows.length.toLocaleString() + ' here) — narrow the filters, or use CSV / Excel for everything.', 'error');
      return;
    }
    if (data.loadAll) toast('Preparing ' + format.toUpperCase() + ' (' + rows.length.toLocaleString() + ' rows)…');
    return gs('exportTable', format, data.title, data.headers, rows).then(function (res) {
      if (res.error) { toast(res.error, 'error'); return; }
      downloadBase64(res.base64, res.mimeType, res.filename);
    });
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
}

function downloadBase64(base64, mimeType, filename) {
  // A Blob instead of a data: URL — browsers refuse data: URLs past ~2 MB, which a big export easily exceeds.
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

/* ================= REPORTS ================= */

function renderReports() {
  const batches = filterBatches();
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Report type</label><select id="repType" onchange="toggleReportFilters(); loadReport();">' +
          '<option value="card">Student Report Card</option>' +
          '<option value="student">Student-wise %</option>' +
          '<option value="batch">Batch/session-wise</option>' +
          '<option value="defaulters">Defaulters (below ' + state.defaulterThreshold + '%)</option>' +
        '</select></div>' +
        '<div class="field" id="repBatchWrap" style="display:none"><label>Batch</label><select id="repBatch" onchange="loadReport()"><option value="">All</option>' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field field-wide" id="repStudentWrap"><label>Student(s) — pick more than one to combine</label>' + studentPickerHtml('repStudent', 'Type student name…', true) + '</div>' +
        '<div class="field"><label>From</label><input type="date" id="repFrom" onchange="loadReport()"></div>' +
        '<div class="field"><label>To</label><input type="date" id="repTo" onchange="loadReport()"></div>' +
      '</div>' +
      '<div class="flex-between"><div id="repCount" class="muted"></div>' +
        exportRowHtml() +
      '</div>' +
      '<div id="repTable" style="margin-top:12px"></div>' +
    '</div>';
  initStudentPicker('repStudent', { multi: true, getStudents: visibleStudents, onChange: function () { loadReport(); } });
  if (pendingReportStudent) {
    const st = visibleStudents().find(function (x) { return x.ID === pendingReportStudent; });
    pendingReportStudent = null;
    if (st) { byId('repType').value = 'card'; toggleReportFilters(); setStudentPicker('repStudent', st); }
  }
  loadReport();
}

function toggleReportFilters() {
  const isCard = document.getElementById('repType').value === 'card';
  document.getElementById('repBatchWrap').style.display = isCard ? 'none' : '';
  document.getElementById('repStudentWrap').style.display = isCard ? '' : 'none';
}

function loadReport() {
  const type = document.getElementById('repType').value;
  const filters = {
    batchId: document.getElementById('repBatch').value,
    from: document.getElementById('repFrom').value,
    to: document.getElementById('repTo').value
  };

  if (type === 'card') {
    const studentIds = (document.getElementById('repStudent').value || '').split(',').filter(Boolean);
    if (!studentIds.length) {
      document.getElementById('repCount').textContent = '';
      document.getElementById('repTable').innerHTML = '<div class="empty-state">Type a student\'s name above and pick them to see the report card. Pick two or more profiles of the same student to see one combined report.</div>';
      return;
    }
    const cacheKey = 'report:card:' + studentIds.join('+') + ':' + JSON.stringify(filters);
    if (!getCache(cacheKey)) document.getElementById('repTable').innerHTML = '<div class="empty-state">Loading…</div>';
    gsSWR(cacheKey, 'getCombinedReportCard', [studentIds, filters], function (data) {
      if ((document.getElementById('repStudent').value || '').split(',').filter(Boolean).join('+') !== studentIds.join('+')) return; // selection changed meanwhile
      if (state.view !== 'reports') return;
      renderReportCard(data);
    });
    return;
  }

  const fn = type === 'student' ? 'getStudentWiseReport' : type === 'batch' ? 'getBatchWiseReport' : 'getDefaultersReport';
  const cacheKey = 'report:' + type + ':' + JSON.stringify(filters);
  if (!getCache(cacheKey)) document.getElementById('repTable').innerHTML = '<div class="empty-state">Loading…</div>';
  gsSWR(cacheKey, fn, [filters], function (data) {
    if (state.view !== 'reports') return;
    document.getElementById('repCount').textContent = data.length + ' row(s)';
    let headers, rows, displayRows;
    if (type === 'batch') {
      headers = ['Date', 'Batch', 'Subject', 'Present', 'Absent', 'Late', 'Total'];
      rows = data.map(function (r) { return [fmtDate(r.date), r.batchName, r.subjectName, r.present, r.absent, r.late, r.total]; });
      displayRows = rows;
    } else {
      headers = ['Student', 'Roll No', 'Sessions', 'Present', 'Absent', '%'];
      rows = data.map(function (r) { return [r.studentName, r.rollNo, r.totalSessions, r.present, r.absent, r.percentage]; });
      displayRows = data.map(function (r) { return [r.studentName, r.rollNo, r.totalSessions, r.present, r.absent, badgePct(r.percentage)]; });
    }
    lastExportData = { title: 'Report_' + type, headers: headers, rows: rows };
    const REPORT_DISPLAY_CAP = 1000; // the table is only for reading — Export always has every row
    if (data.length > REPORT_DISPLAY_CAP) {
      document.getElementById('repCount').textContent = data.length.toLocaleString() + ' row(s) — showing the first ' + REPORT_DISPLAY_CAP.toLocaleString() + '. Narrow the filters, or Export for all.';
      displayRows = displayRows.slice(0, REPORT_DISPLAY_CAP);
    }
    document.getElementById('repTable').innerHTML = data.length ? renderTable(headers, displayRows) : '<div class="empty-state">No data for this filter.</div>';
  });
}

/** The full per-student report card: profile line, summary stats, and every record. */
function renderReportCard(data) {
  document.getElementById('repCount').textContent = data.records.length + ' record(s)';
  if (!data.student) { document.getElementById('repTable').innerHTML = '<div class="empty-state">Student not found.</div>'; return; }
  const s = data.student, sum = data.summary;

  const headers = ['Date', 'Batch', 'Subject', 'Status', 'Remark', 'Reason'];
  const rows = data.records.map(function (r) { return [fmtDate(r.date), r.batchName, r.subjectName, r.status, r.remark, r.reason]; });
  lastExportData = { title: 'Report_Card_' + s.name.replace(/[\s\/]+/g, '_'), headers: headers, rows: rows };

  document.getElementById('repTable').innerHTML =
    '<div class="card" style="margin-bottom:16px">' +
      '<h3 style="margin-top:0">' + esc(s.name) + (s.rollNo ? ' <span class="muted">(' + esc(s.rollNo) + ')</span>' : '') + '</h3>' +
      '<p class="muted" style="margin:0 0 ' + (data.profiles && data.profiles.length > 1 ? '8' : '14') + 'px">' + esc(s.batchName) +
        ((s.contacts || []).length ? ' &middot; ' + s.contacts.map(function (c) { return esc(c.label) + ': ' + esc(c.number); }).join(' &middot; ') : '') + '</p>' +
      (data.profiles && data.profiles.length > 1
        ? '<div class="profile-list"><div class="muted" style="margin-bottom:4px">Combined report of ' + data.profiles.length + ' profiles:</div>' +
          data.profiles.map(function (pf) {
            return '<div class="profile-row"><span><b>' + esc(pf.name) + '</b>' + (pf.rollNo ? ' (' + esc(pf.rollNo) + ')' : '') + ' · ' + esc(pf.batchName) + '</span>' +
              '<span class="muted">' + pf.summary.present + ' / ' + pf.summary.total + ' · ' + pf.summary.percentage + '%</span></div>';
          }).join('') + '</div>'
        : '') +
      '<div class="stat-grid">' +
        statCard(sum.total, 'Sessions') + statCard(sum.present, 'Present') + statCard(sum.absent, 'Absent') +
        '<div class="stat-card"><div class="num">' + badgePct(sum.percentage) + '</div><div class="label">Attendance</div></div>' +
      '</div>' +
    '</div>' +
    (data.records.length
      ? renderTable(headers, data.records.map(function (r) {
          return [fmtDate(r.date), esc(r.batchName), esc(r.subjectName), statusBadge(r.status), r.remark ? esc(r.remark) : '<span class="muted">—</span>', r.reason ? esc(r.reason) : '<span class="muted">—</span>'];
        }))
      : '<div class="empty-state">No attendance records in this range yet.</div>');
}

/* ================= BATCHES ================= */

function renderBatches() {
  const content = document.getElementById('content');
  const countFor = function (id) { return state.students.filter(function (s) { return s.BatchID === id; }).length; };
  const closed = state.closedBatches || [];
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Batches</h3><button class="btn btn-primary btn-sm" onclick="openBatchModal()">+ Add batch</button></div>' +
      (state.batches.length ? renderTable(['Name', 'Description', 'Students', ''], state.batches.map(function (b) {
        return [esc(b.Name), esc(b.Description || ''), countFor(b.ID),
          '<a class="link" onclick=\'openBatchModal(' + JSON.stringify(b.ID) + ')\'>Edit</a> &nbsp; ' +
          (hasPerm('student_edit') ? '<a class="link" onclick="openMergeModal(\'' + b.ID + '\')">Merge into…</a> &nbsp; ' : '') +
          '<a class="link" style="color:#d97706" onclick="closeBatchConfirm(this,\'' + b.ID + '\')">Close</a> &nbsp; ' +
          '<a class="link" style="color:#dc2626" onclick="deleteBatchConfirm(this,\'' + b.ID + '\')">Delete</a>'];
      })) : '<div class="empty-state">No open batches.</div>') +
    '</div>' +
    (closed.length ?
      '<div class="card"><div class="card-header"><h3>Closed batches</h3></div>' +
        '<p class="muted" style="margin-top:-6px">Closed batches are hidden from Mark Attendance and Absentees Calling. Their students and attendance history are kept.</p>' +
        renderTable(['Name', 'Description', 'Closed on', ''], closed.map(function (b) {
          return [esc(b.Name), esc(b.Description || ''), b.ClosedAt ? fmtDate(b.ClosedAt) : '—',
            '<a class="link" onclick="restoreBatchConfirm(this,\'' + b.ID + '\')">Restore</a> &nbsp; ' +
            '<a class="link" style="color:#dc2626" onclick="deleteBatchConfirm(this,\'' + b.ID + '\')">Delete</a>'];
        })) + '</div>' : '');
}

function openBatchModal(id) {
  const batch = id ? state.batches.concat(state.closedBatches || []).find(function (b) { return b.ID === id; }) : null;
  showModal('batchModal', (batch ? 'Edit' : 'Add') + ' batch',
    '<div class="field"><label>Name</label><input id="bName" value="' + esc(batch ? batch.Name : '') + '"></div>' +
    '<div class="field"><label>Description</label><textarea id="bDesc" rows="2">' + esc(batch ? batch.Description : '') + '</textarea></div>',
    function () {
      const data = { name: document.getElementById('bName').value.trim(), description: document.getElementById('bDesc').value.trim() };
      if (!data.name) { toast('Name is required', 'error'); return; }
      const call = batch ? gs('updateBatch', state.user.role, Object.assign({ id: batch.ID }, data)) : gs('createBatch', state.user.role, data);
      return call.then(function () { closeModal(); return refreshData(); }).then(function () { renderBatches(); toast('Saved', 'success'); });
    });
}
function openMergeModal(fromId) {
  const from = state.batches.find(function (b) { return b.ID === fromId; });
  const targets = state.batches.filter(function (b) { return b.ID !== fromId; });
  if (!from || !targets.length) { toast('There is no other running batch to merge into', 'error'); return; }
  const count = state.students.filter(function (s) { return s.BatchID === fromId; }).length;
  showModal('mergeModal', 'Merge batch',
    '<p style="margin-top:0">All <strong>' + count + '</strong> running students of <strong>' + esc(from.Name) + '</strong> will move into the batch you pick. ' +
    'Discontinued students stay as they are. Everything already marked stays in ' + esc(from.Name) + ', and each student\'s Report Card shows old + new together.</p>' +
    '<div class="field"><label>Merge into</label><select id="mergeTo">' + targets.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>Merged on (first day in the new batch)</label><input type="date" id="mergeDate" value="' + todayStr() + '"></div>' +
    '<label class="check-row"><input type="checkbox" id="mergeClose" checked> Close ' + esc(from.Name) + ' after merging</label>',
    function () {
      const to = document.getElementById('mergeTo').value, date = document.getElementById('mergeDate').value, close = document.getElementById('mergeClose').checked;
      if (!date) { toast('Pick the date', 'error'); return; }
      if (!confirm('Move ' + count + ' students from ' + from.Name + ' into ' + batchNameAny(to) + ' from ' + fmtDate(date) + (close ? ' and close ' + from.Name : '') + '?')) return;
      return gs('mergeBatchInto', state.user.role, fromId, to, date, close)
        .then(function (res) { closeModal(); return refreshData().then(function () { clearAttendanceCaches(); renderBatches(); toast(res.moved + ' students moved' + (close ? ', batch closed' : ''), 'success'); }); })
        .catch(function (e) { toast(e.message || String(e), 'error'); });
    }, 'Merge');
}
function closeBatchConfirm(el, id) {
  if (!confirm('Close this batch?\n\nIt will disappear from Mark Attendance and Absentees Calling. Students and all attendance history are kept, and you can restore it any time.')) return;
  runWithLoading(el, 'Closing…', function () {
    return gs('closeBatch', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderBatches(); toast('Batch closed', 'success'); })
      .catch(function (e) { toast(e.message || String(e), 'error'); });
  });
}
function restoreBatchConfirm(el, id) {
  runWithLoading(el, 'Restoring…', function () {
    return gs('restoreBatch', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderBatches(); toast('Batch restored', 'success'); })
      .catch(function (e) { toast(e.message || String(e), 'error'); });
  });
}
function deleteBatchConfirm(el, id) {
  if (!confirm('Delete this batch? Students/subjects in it will remain but be unassigned. (To keep it for later, use Close instead.)')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteBatch', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderBatches(); toast('Deleted', 'success'); })
      .catch(function (e) { toast(e.message || String(e), 'error'); });
  });
}

/* ================= SUBJECTS (admin) ================= */

function renderSubjects() {
  const batchName = batchNameAny;
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Subjects</h3><button class="btn btn-primary btn-sm" onclick="openSubjectModal()">+ Add subject</button></div>' +
      renderTable(['Name', 'Batch', ''], state.subjects.map(function (s) {
        return [esc(s.Name), esc(batchName(s.BatchID)),
          '<a class="link" onclick=\'openSubjectModal(' + JSON.stringify(s.ID) + ')\'>Edit</a> &nbsp; ' +
          '<a class="link" style="color:#dc2626" onclick="deleteSubjectConfirm(this,\'' + s.ID + '\')">Delete</a>'];
      })) +
    '</div>';
}
function openSubjectModal(id) {
  const subject = id ? state.subjects.find(function (s) { return s.ID === id; }) : null;
  showModal('subjectModal', (subject ? 'Edit' : 'Add') + ' subject',
    '<div class="field"><label>Name</label><input id="sName" value="' + esc(subject ? subject.Name : '') + '"></div>' +
    '<div class="field"><label>Batch</label><select id="sBatch">' +
      state.batches.map(function (b) { return '<option value="' + b.ID + '"' + (subject && subject.BatchID === b.ID ? ' selected' : '') + '>' + esc(b.Name) + '</option>'; }).join('') +
    '</select></div>',
    function () {
      const data = { name: document.getElementById('sName').value.trim(), batchId: document.getElementById('sBatch').value };
      if (!data.name) { toast('Name is required', 'error'); return; }
      const call = subject ? gs('updateSubject', state.user.role, Object.assign({ id: subject.ID }, data)) : gs('createSubject', state.user.role, data);
      return call.then(function () { closeModal(); return refreshData(); }).then(function () { renderSubjects(); toast('Saved', 'success'); });
    });
}
function deleteSubjectConfirm(el, id) {
  if (!confirm('Delete this subject?')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteSubject', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderSubjects(); toast('Deleted', 'success'); });
  });
}

/* ================= STUDENTS ================= */

let studentsFilter = { batch: '', q: '' };

/** The students this login may see on the Students page (non-admins: only their own batches). */
function studentsBase_() {
  if (isAdmin()) return state.students;
  return state.students.filter(function (s) { return state.user.assignedBatchIds.indexOf(s.BatchID) !== -1; });
}

function renderStudents() {
  const content = document.getElementById('content');
  const base = studentsBase_();
  const counts = {};
  base.forEach(function (s) { counts[s.BatchID || ''] = (counts[s.BatchID || ''] || 0) + 1; });
  const batchOptions = filterBatches().map(function (b) {
    return '<option value="' + b.ID + '"' + (studentsFilter.batch === b.ID ? ' selected' : '') + '>' + esc(b.Name) + (b.Closed ? ' (Closed)' : '') + ' (' + (counts[b.ID] || 0) + ')</option>';
  }).join('');
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Students</h3><div>' +
        (hasPerm('bulk_import') ? '<button class="btn btn-secondary btn-sm" onclick="openBulkImport()">Bulk import</button> ' : '') +
        (hasPerm('student_add') ? '<button class="btn btn-primary btn-sm" onclick="openStudentModal()">+ Add student</button>' : '') + '</div></div>' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="studentBatchFilter" onchange="renderStudentsTable()"><option value="">All batches (' + base.length + ')</option>' + batchOptions + '</select></div>' +
        '<div class="field"><label>Search</label><input type="text" id="studentSearch" placeholder="Name, roll no, or phone…" value="' + esc(studentsFilter.q) + '" oninput="renderStudentsTable()"></div>' +
      '</div>' +
      '<div id="studentsTableArea"></div>' +
    '</div>';
  renderStudentsTable();
}
function renderStudentsTable() {
  studentsFilter.q = (document.getElementById('studentSearch').value || '').trim();
  studentsFilter.batch = document.getElementById('studentBatchFilter').value;
  const q = studentsFilter.q.toLowerCase();
  let filtered = studentsBase_();
  if (studentsFilter.batch) filtered = filtered.filter(function (s) { return s.BatchID === studentsFilter.batch; });
  if (q) filtered = filtered.filter(function (s) {
    return String(s.Name || '').toLowerCase().indexOf(q) !== -1 ||
      String(s.RollNo || '').toLowerCase().indexOf(q) !== -1 ||
      contactNums_(s).toLowerCase().indexOf(q) !== -1;
  });
  document.getElementById('studentsTableArea').innerHTML = filtered.length
    ? '<div class="muted" style="margin-bottom:8px">' + filtered.length + ' student(s)</div>' + renderTable(['Name', 'Roll No', 'Batch', 'Contact numbers (call in this order)', ''], filtered.map(function (s) {
        return [esc(s.Name) + (s.Highlighted ? ' <span class="hl-flag" title="' + esc(s.HighlightRemark) + '">⚑</span>' : ''), esc(s.RollNo || ''), esc(batchNameAny(s.BatchID)), contactsHtml(s.Contacts),
          (hasPerm('student_edit') ? '<a class="link" onclick=\'openStudentModal(' + JSON.stringify(s.ID) + ')\'>Edit</a> &nbsp; <a class="link" onclick="openShiftModal(\'' + s.ID + '\')">Shift batch</a> &nbsp; ' : '') +
          (hasPerm('student_discontinue') ? '<a class="link" style="color:#d97706" onclick=\'openDiscontinueModal(' + JSON.stringify(s.ID) + ')\'>Discontinue</a> &nbsp; ' : '') +
          (hasPerm('student_delete') ? '<a class="link" style="color:#dc2626" onclick="deleteStudentConfirm(this,\'' + s.ID + '\')">Delete</a>' : '')];
      }))
    : '<div class="empty-state">No students match' + (studentsFilter.batch ? ' in this batch' : '') + (q ? ' "' + esc(studentsFilter.q) + '"' : '') + '.</div>';
}
function openStudentModal(id) {
  const student = id ? state.students.find(function (s) { return s.ID === id; }) : null;
  const batchOpts = state.batches.concat(student && !state.batches.some(function (b) { return b.ID === student.BatchID; })
    ? (state.closedBatches || []).filter(function (b) { return b.ID === student.BatchID; }) : []);
  showModal('studentModal', (student ? 'Edit' : 'Add') + ' student',
    '<div class="field-row">' +
      '<div class="field"><label>Name</label><input id="stName" value="' + esc(student ? student.Name : '') + '"></div>' +
      '<div class="field"><label>Roll No</label><input id="stRoll" value="' + esc(student ? student.RollNo : '') + '"></div>' +
    '</div>' +
    (student
      ? '<div class="field"><label>Batch</label><div>' + esc(batchNameAny(student.BatchID)) + ' &nbsp; <a class="link" onclick="closeModal();openShiftModal(\'' + student.ID + '\')">Shift to another batch…</a> &nbsp; <a class="link" onclick="closeModal();openBatchHistoryModal(\'' + student.ID + '\')">Batch history…</a></div>' +
        '<div class="muted" style="font-size:12px;margin-top:4px">Shifting keeps the same student profile and all old attendance.</div></div>'
      : '<div class="field"><label>Batch</label><select id="stBatch">' +
        batchOpts.map(function (b) { return '<option value="' + b.ID + '"' + (studentsFilter.batch === b.ID ? ' selected' : '') + '>' + esc(b.Name) + '</option>'; }).join('') +
      '</select></div>') +
    '<div class="field"><label>Mobile numbers — in the order they should be called</label>' +
      '<div id="contactList"></div>' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="addContactRow()">+ Add another number</button>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">Use the ↑ ↓ buttons to set who is called first. If the first number is not answered, the next one is tried.</div>' +
    '</div>' +
    '<div class="field"><label>Email</label><input id="stEmail" value="' + esc(student ? student.Email : '') + '"></div>',
    function () {
      const data = {
        name: document.getElementById('stName').value.trim(),
        rollNo: document.getElementById('stRoll').value.trim(),
        batchId: student ? undefined : document.getElementById('stBatch').value,
        email: document.getElementById('stEmail').value.trim()
      };
      if (!data.name) { toast('Name is required', 'error'); return; }
      const contacts = collectContacts();
      if (contacts === null) return;
      data.contacts = contacts;
      const call = student ? gs('updateStudent', state.user.role, Object.assign({ id: student.ID }, data)) : gs('createStudent', state.user.role, data);
      return call.then(function () { closeModal(); return refreshData(); }).then(function () { renderStudents(); toast('Saved', 'success'); })
        .catch(function (e) { toast(e.message || String(e), 'error'); });
    });
  const start = student ? student.Contacts : [];
  if (start.length) start.forEach(function (c) { addContactRow(c.label, c.number); });
  else { addContactRow('Student', ''); addContactRow('Father', ''); }
}

/* ----- ordered contact numbers (student modal) ----- */
const CONTACT_LABELS = ['Student', 'Father', 'Mother', 'Guardian', 'Brother', 'Sister', 'Uncle', 'Aunt', 'Grandparent', 'Other'];
function contactsHtml(contacts) {
  if (!contacts || !contacts.length) return '<span class="muted">—</span>';
  return contacts.map(function (c, i) { return '<div class="contact-line">' + (i + 1) + '. <span class="muted">' + esc(c.label) + '</span> ' + esc(c.number) + '</div>'; }).join('');
}
function addContactRow(label, number) {
  const list = byId('contactList');
  const known = CONTACT_LABELS.indexOf(label) !== -1;
  if (label && !known) label = 'Other'; // e.g. an older "Parent" entry
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = '<span class="contact-no"></span>' +
    '<select class="c-label">' + CONTACT_LABELS.map(function (l) { return '<option' + (l === (label || 'Other') ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select>' +
    '<input class="c-number" type="tel" inputmode="tel" placeholder="Mobile number" value="' + esc(number || '') + '">' +
    '<button type="button" class="icon-btn" onclick="moveContact(this,-1)" title="Call earlier">↑</button>' +
    '<button type="button" class="icon-btn" onclick="moveContact(this,1)" title="Call later">↓</button>' +
    '<button type="button" class="icon-btn danger" onclick="removeContact(this)" title="Remove">&times;</button>';
  list.appendChild(row);
  renumberContacts();
}
function renumberContacts() {
  Array.prototype.forEach.call(document.querySelectorAll('#contactList .contact-row'), function (row, i) { row.querySelector('.contact-no').textContent = (i + 1) + '.'; });
}
function moveContact(btn, dir) {
  const row = btn.closest('.contact-row'), list = row.parentNode;
  if (dir < 0 && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
  else if (dir > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  renumberContacts();
}
function removeContact(btn) { btn.closest('.contact-row').remove(); renumberContacts(); }
/** Returns the cleaned ordered list, or null (after showing a message) if a number looks wrong. */
function collectContacts() {
  const out = [];
  const rows = document.querySelectorAll('#contactList .contact-row');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i].querySelector('.c-number').value.trim();
    if (!raw) continue;
    const num = raw.replace(/[\s-]/g, '');
    if (!/^\+?[0-9]{7,15}$/.test(num)) { toast('Number ' + (i + 1) + ' (' + raw + ') does not look right', 'error'); return null; }
    out.push({ label: rows[i].querySelector('.c-label').value, number: num });
  }
  return out;
}
function openShiftModal(id) {
  const s = state.students.find(function (x) { return x.ID === id; });
  if (!s) return;
  const options = state.batches.filter(function (b) { return b.ID !== s.BatchID; });
  if (!options.length) { toast('There is no other running batch to shift to', 'error'); return; }
  showModal('shiftModal', 'Shift to another batch',
    '<p style="margin-top:0"><strong>' + esc(s.Name) + '</strong> is now in <strong>' + esc(batchNameAny(s.BatchID)) + '</strong>. After shifting, they stop appearing on the old batch\'s attendance sheet from the date below. ' +
    'Everything already marked stays in the old batch, and the Report Card shows old + new together under this one profile.</p>' +
    '<div class="field"><label>New batch</label><select id="shiftBatch">' + options.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>Shifted on (first day in the new batch)</label><input type="date" id="shiftDate" value="' + todayStr() + '"></div>',
    function () {
      const nb = document.getElementById('shiftBatch').value, date = document.getElementById('shiftDate').value;
      if (!date) { toast('Pick the date', 'error'); return; }
      return gs('shiftStudentBatch', state.user.role, id, nb, date)
        .then(function () { closeModal(); return refreshData(); })
        .then(function () { clearAttendanceCaches(); renderStudents(); toast('Student shifted', 'success'); })
        .catch(function (e) { toast(e.message || String(e), 'error'); });
    }, 'Shift');
}
function openDiscontinueModal(id) {
  const s = state.students.find(function (x) { return x.ID === id; });
  if (!s) return;
  showModal('discModal', 'Discontinue student',
    '<p style="margin-top:0"><strong>' + esc(s.Name) + '</strong>' + (s.RollNo ? ' (' + esc(s.RollNo) + ')' : '') + ' will move to the <em>Discontinued Students</em> page and will no longer appear in attendance sheets. Past attendance is kept, and you can restore the student any time.</p>' +
    '<div class="field"><label>Reason (optional)</label><input id="discReason" placeholder="e.g. Left the institute, fee not paid, shifted city"></div>',
    function () {
      const reason = document.getElementById('discReason').value.trim();
      return gs('discontinueStudent', state.user.role, id, reason)
        .then(function () { closeModal(); return refreshData(); })
        .then(function () { clearAttendanceCaches(); renderStudents(); toast('Student discontinued', 'success'); })
        .catch(function (e) { toast(e.message || String(e), 'error'); });
    }, 'Discontinue');
}
function deleteStudentConfirm(el, id) {
  if (!confirm('Delete this student? Their past attendance history is kept. (To keep the student on file, use Discontinue instead.)')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteStudent', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderStudents(); toast('Deleted', 'success'); })
      .catch(function (e) { toast(e.message || String(e), 'error'); });
  });
}

/* ================= DISCONTINUED STUDENTS ================= */

function renderDiscontinued() {
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Discontinued students (' + (state.discontinued || []).length + ')</h3></div>' +
      '<div class="field" style="max-width:320px"><input type="text" id="discSearch" placeholder="Search by name, roll no, or phone…" oninput="renderDiscontinuedTable()"></div>' +
      '<div id="discTableArea"></div>' +
    '</div>';
  renderDiscontinuedTable();
}
function renderDiscontinuedTable() {
  const q = (document.getElementById('discSearch').value || '').trim().toLowerCase();
  const all = state.discontinued || [];
  const filtered = !q ? all : all.filter(function (s) {
    return [s.Name, s.RollNo, contactNums_(s)].some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
  });
  document.getElementById('discTableArea').innerHTML = filtered.length
    ? renderTable(['Name', 'Roll No', 'Batch', 'Contact numbers', 'Discontinued on', 'Reason', ''], filtered.map(function (s) {
        return [esc(s.Name), esc(s.RollNo || ''), esc(batchNameAny(s.BatchID)), contactsHtml(s.Contacts),
          s.DiscontinuedAt ? fmtDate(s.DiscontinuedAt) : '—', s.DiscontinueReason ? esc(s.DiscontinueReason) : '<span class="muted">—</span>',
          (hasPerm('reports') ? '<a class="link" onclick="viewStudentCard(\'' + s.ID + '\')">Report card</a> &nbsp; ' : '') +
          '<a class="link" style="color:#16a34a" onclick="restoreStudentConfirm(this,\'' + s.ID + '\')">Restore</a>'];
      }))
    : '<div class="empty-state">' + (q ? 'No discontinued students match "' + esc(q) + '".' : 'No discontinued students.') + '</div>';
}
function restoreStudentConfirm(el, id) {
  if (!confirm('Restore this student? They will appear in their batch\'s attendance sheet again.')) return;
  runWithLoading(el, 'Restoring…', function () {
    return gs('restoreStudent', state.user.role, id).then(function () { return refreshData(); })
      .then(function () { clearAttendanceCaches(); renderDiscontinued(); toast('Student restored', 'success'); })
      .catch(function (e) { toast(e.message || String(e), 'error'); });
  });
}
let pendingReportStudent = null;
function viewStudentCard(id) { pendingReportStudent = id; setView('reports'); }

function openBulkImport() {
  showModal('bulkModal', 'Bulk import students',
    '<div class="field"><label>Batch</label><select id="biBatch">' +
      state.batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field">' +
      '<label>Upload a CSV file</label>' +
      '<input type="file" id="biFile" accept=".csv,text/csv" onchange="handleCsvFileSelect(this)">' +
      '<div style="margin-top:6px"><a class="link" onclick="downloadSampleCsv()">Download sample CSV</a></div>' +
    '</div>' +
    '<div class="field"><label>...or paste rows — one student per line: Name, Roll No, Phone, Email</label>' +
      '<textarea id="biText" rows="8" placeholder="Riya Sharma, 101, 9876543210, riya@example.com"></textarea></div>' +
    '<div id="biPreview" class="muted" style="font-size:12.5px"></div>',
    function () {
      const batchId = document.getElementById('biBatch').value;
      const text = document.getElementById('biText').value.trim();
      if (!text) { toast('Upload a CSV or paste at least one row', 'error'); return; }
      return gs('bulkImportStudents', state.user.role, batchId, text).then(function (res) {
        closeModal(); return refreshData().then(function () { renderStudents(); toast('Imported ' + res.count + ' students', 'success'); });
      });
    });
}

/** CSV file → drops its contents straight into the same textarea the paste path uses,
 *  so both routes share one import call. Handles a trailing blank line from Excel/Sheets exports. */
function handleCsvFileSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const text = String(e.target.result || '').trim();
    document.getElementById('biText').value = text;
    const rowCount = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).length;
    document.getElementById('biPreview').textContent = file.name + ' loaded — ' + rowCount + ' row(s) ready to import.';
  };
  reader.onerror = function () { toast('Could not read that file', 'error'); };
  reader.readAsText(file);
}

/** A ready-to-fill CSV so people know the exact column order/headers expected. */
function downloadSampleCsv() {
  const csv = 'Name,Roll No,Phone,Email\r\nRiya Sharma,101,9876543210,riya@example.com\r\nArjun Mehta,102,9876500000,arjun@example.com\r\n';
  downloadBase64(btoa(unescape(encodeURIComponent(csv))), 'text/csv', 'students_sample.csv');
}

/* ================= BULK ATTENDANCE IMPORT (admin, historical backfill) ================= */

let pendingAttendanceCsv = ''; // a chosen file's text is kept here (not dumped into the textarea — files can be megabytes)

function importProgress(msg) {
  const el = document.getElementById('biaPreview');
  if (el) el.textContent = msg;
}

function openBulkImportAttendance() {
  pendingAttendanceCsv = '';
  showModal('bulkAttModal', 'Bulk import attendance history',
    '<p class="muted" style="margin-top:0">For importing months of past records at once. Batches, students, and the three class slots are created automatically if they don\'t already exist — no need to set anything up first.</p>' +
    '<div class="field">' +
      '<label>Upload a CSV file</label>' +
      '<input type="file" id="biaFile" accept=".csv,text/csv" onchange="handleAttendanceCsvFileSelect(this)">' +
      '<div style="margin-top:6px"><a class="link" onclick="downloadSampleAttendanceCsv()">Download sample CSV</a></div>' +
    '</div>' +
    '<div class="field"><label>...or paste a few CSV rows directly</label>' +
      '<textarea id="biaText" rows="4" placeholder="Riya Sharma,101,9876500001,9876543210,IIT JEE Excel-1,15/06/2026,Present,Absent,Present,,"></textarea></div>' +
    '<div id="biaPreview" class="muted" style="font-size:12.5px;min-height:18px"></div>' +
    '<p class="muted" style="font-size:12px">Columns, in order: Name, Roll Number, Parent Mobile, Student Mobile, Batch, Date (15/06/2026 or 15-6-26 both work), 1st Class, 2nd Class, 3rd Class, Remark, Reason. Students are matched by roll number within a batch (by name only if the roll number is blank). A blank class cell, or Sunday / Holiday / Week Off / No Class, means no class that day — nothing is recorded for it. Re-uploading the same file is safe: rows already in the database are skipped.</p>',
    function () {
      const text = (document.getElementById('biaText').value.trim()) || pendingAttendanceCsv;
      if (!text) { toast('Upload a CSV or paste rows first', 'error'); return; }
      importProgress('Starting…');
      return gs('bulkImportAttendance', state.user.role, text).then(function (res) {
        closeModal();
        pendingAttendanceCsv = '';
        clearAttendanceCaches();
        return refreshData().then(function () {
          renderRecords();
          showImportSummary(res);
        });
      }).catch(function (e) {
        importProgress('');
        toast(e.message || String(e), 'error');
      });
    });
}

function handleAttendanceCsvFileSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    pendingAttendanceCsv = String(e.target.result || '');
    document.getElementById('biaText').value = '';
    importProgress(file.name + ' loaded (' + (file.size / 1048576).toFixed(1) + ' MB) — press Save to import it.');
  };
  reader.onerror = function () { toast('Could not read that file', 'error'); };
  reader.readAsText(file);
}

/** What happened, in plain terms — including anything that was set aside and why. */
function showImportSummary(r) {
  const n = function (x) { return Number(x || 0).toLocaleString(); };
  let html =
    '<p style="margin-top:0"><strong>' + n(r.inserted) + '</strong> attendance record(s) added' +
    (r.alreadyThere ? ' <span class="muted">(' + n(r.alreadyThere) + ' were already in the database)</span>' : '') + '.</p>' +
    '<ul style="padding-left:18px;line-height:1.6">';
  if (r.newBatches || r.newStudents || r.newSubjects) {
    html += '<li>Created ' + n(r.newBatches) + ' batch(es), ' + n(r.newStudents) + ' student(s), ' + n(r.newSubjects) + ' class slot(s).</li>';
  }
  if (r.noClassRows) html += '<li>' + n(r.noClassRows) + ' row(s) had no Present/Absent in any class (blank, Sunday, holiday…) — nothing to record.</li>';
  if (r.duplicateRows) html += '<li>' + n(r.duplicateRows) + ' duplicate entr' + (r.duplicateRows === 1 ? 'y' : 'ies') + ' for the same student, class and day — the first one was kept.</li>';
  if (r.missingFieldRows) html += '<li>' + n(r.missingFieldRows) + ' row(s) skipped: name or batch missing.</li>';
  if (r.invalidDates && r.invalidDates.count) {
    html += '<li><strong>' + n(r.invalidDates.count) + ' row(s) skipped — date not understood</strong>: ' +
      r.invalidDates.samples.map(function (x) { return 'row ' + n(x.row) + ' ("' + esc(x.value) + '")'; }).join(', ') +
      (r.invalidDates.count > r.invalidDates.samples.length ? ' …' : '') + '</li>';
  }
  if (r.nameMismatch && r.nameMismatch.count) {
    html += '<li>' + n(r.nameMismatch.count) + ' row(s) had the same roll number as an existing student but a different spelling of the name — treated as the same student. e.g. ' +
      r.nameMismatch.samples.slice(0, 3).map(function (x) { return esc(x.roll) + ': ' + esc(x.kept) + ' / ' + esc(x.alsoSeen); }).join('; ') + '</li>';
  }
  html += '</ul>';
  if (r.unrecognized && r.unrecognized.length) {
    html += '<p style="margin-bottom:4px"><strong>Not imported — these cells in a class column weren\'t Present/Absent:</strong></p>' +
      '<p class="muted" style="margin-top:0;font-size:13px">' +
      r.unrecognized.map(function (u) { return '“' + esc(u.value) + '” ×' + n(u.count); }).join(' &nbsp;·&nbsp; ') +
      '<br>Looks like call notes typed into the wrong column. If they should count as Absent, change them to “Absent” in the file and import again (already-imported rows are skipped).</p>';
  }
  showInfoModal('Import finished', html);
}

function showInfoModal(title, bodyHtml) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal" style="width:560px"><h3>' + esc(title) + '</h3><div>' + bodyHtml + '</div>' +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">OK</button></div></div>';
  document.body.appendChild(overlay);
}

function downloadSampleAttendanceCsv() {
  const csv = 'Name,Roll Number,Parent Mobile,Student Mobile,Batch,Date,1st Class,2nd Class,3rd Class,Remark,Reason\r\n' +
    'Riya Sharma,101,9876500001,9876543210,IIT JEE Excel-1,15/06/2026,Present,Present,Absent,Left early,"Had a family function in the evening, informed a day in advance"\r\n' +
    'Arjun Mehta,102,9876500002,9876543211,IIT JEE Excel-1,15/06/2026,Absent,Absent,Absent,,Down with fever\r\n';
  downloadBase64(btoa(unescape(encodeURIComponent(csv))), 'text/csv', 'attendance_history_sample.csv');
}

/* ================= STAFF LOGINS (admin) ================= */

function renderTeachers() {
  const content = document.getElementById('content');
  const cached = getCache('users');
  if (!cached) content.innerHTML = '<div class="card"><div class="empty-state">Loading…</div></div>';
  gsSWR('users', 'listUsers', [state.user.role], function (users) {
    if (state.view !== 'teachers') return;
    const batchNames = function (ids) { return (ids || []).map(function (id) { return batchNameAny(id); }).filter(function (n) { return n !== '(unassigned)'; }).join(', ') || '—'; };
    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h3>Staff logins</h3><button class="btn btn-primary btn-sm" onclick="openUserModal()">+ Add login</button></div>' +
        renderTable(['Name', 'Username', 'Role', 'Access', 'Assigned batches', 'Status', ''], users.map(function (u) {
          const access = u.role === 'Admin' ? 'Full access'
            : (u.permissions || []).map(function (k) { const p = PERMISSIONS.find(function (x) { return x.key === k; }); return p ? p.label.replace(/ \(.*\)/, '') : ''; }).filter(Boolean).join(', ') || '—';
          return [esc(u.name), esc(u.username), esc(u.role), '<span style="font-size:12.5px">' + esc(access) + '</span>',
            u.role === 'Admin' ? '<span class="muted">All</span>' : esc(batchNames(u.assignedBatchIds)),
            u.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Disabled</span>',
            '<a class="link" onclick=\'openUserModal(' + JSON.stringify(u.id) + ')\'>Edit</a> &nbsp; ' +
            (u.username !== 'admin' ? '<a class="link" style="color:#dc2626" onclick="deleteUserConfirm(this,\'' + u.id + '\')">Delete</a>' : '')];
        })) +
      '</div>';
  });
}

function openUserModal(id) {
  gs('listUsers', state.user.role).then(function (users) {
    const u = id ? users.find(function (x) { return x.id === id; }) : null;
    const isCustomRole = !!u && u.role !== 'Admin' && u.role !== 'Teacher';
    const startRole = !u ? 'Teacher' : isCustomRole ? '__custom' : u.role;
    const startPerms = u ? (u.role === 'Admin' ? [] : (u.permissions || [])) : ROLE_PRESETS['Teacher'];
    const batches = state.batches.concat(state.closedBatches || []);
    showModal('userModal', (u ? 'Edit' : 'Add') + ' login',
      '<div class="field"><label>Name</label><input id="uName" value="' + esc(u ? u.name : '') + '"></div>' +
      '<div class="field"><label>Username</label><input id="uUsername" autocapitalize="off" value="' + esc(u ? u.username : '') + '"' + (u ? ' disabled' : '') + '></div>' +
      '<div class="field"><label>' + (u ? 'New password (leave blank to keep current)' : 'Password') + '</label><input id="uPassword" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label>Role</label><select id="uRole" onchange="onUserRoleChange()">' +
        '<option value="Teacher"' + (startRole === 'Teacher' ? ' selected' : '') + '>Teacher</option>' +
        '<option value="__custom"' + (startRole === '__custom' ? ' selected' : '') + '>Custom role…</option>' +
        '<option value="Admin"' + (startRole === 'Admin' ? ' selected' : '') + '>Admin</option>' +
      '</select></div>' +
      '<div class="field" id="customRoleWrap" style="display:none"><label>Custom role name</label><input id="uRoleName" placeholder="e.g. Tele Caller, Floor Incharge, Coordinator" value="' + esc(isCustomRole ? u.role : '') + '"></div>' +
      '<div class="field" id="permWrap"><label>What can this login access? (tick / untick anything)</label>' +
        PERMISSIONS.map(function (p) {
          return '<label class="check-row' + (p.parent ? ' perm-child' : '') + '"><input type="checkbox" class="permCheck" value="' + p.key + '"' + (p.parent ? ' data-parent="' + p.parent + '"' : '') +
            ' onchange="onPermChange(this)"' + (startPerms.indexOf(p.key) !== -1 ? ' checked' : '') + '> ' + esc(p.label) + '</label>';
        }).join('') +
      '</div>' +
      '<div class="field" id="batchPickerWrap"><label>Batches this login can work with</label>' +
        (batches.length ? batches.map(function (b) {
          const checked = u && (u.assignedBatchIds || []).indexOf(b.ID) !== -1;
          return '<label class="check-row"><input type="checkbox" class="batchCheck" value="' + b.ID + '"' + (checked ? ' checked' : '') + '> ' + esc(b.Name) + (b.Closed ? ' (Closed)' : '') + '</label>';
        }).join('') : '<span class="muted">No batches yet.</span>') +
      '</div>' +
      '<div id="adminNote" class="muted" style="display:none">Admin always has full access to everything, including all batches.</div>' +
      (u ? '<label class="check-row" style="margin-top:10px"><input type="checkbox" id="uActive"' + (u.active ? ' checked' : '') + '> Login enabled</label>' : ''),
      function () {
        const assignedBatchIds = Array.prototype.map.call(document.querySelectorAll('.batchCheck:checked'), function (c) { return c.value; });
        let role = document.getElementById('uRole').value;
        if (role === '__custom') {
          role = document.getElementById('uRoleName').value.trim();
          if (!role) { toast('Type the custom role name', 'error'); return; }
          if (role.toLowerCase() === 'admin') { toast('"Admin" is a fixed role — pick Admin from the list instead', 'error'); return; }
        }
        const password = document.getElementById('uPassword').value;
        const permissions = role === 'Admin' ? ROLE_PRESETS['Admin'] : Array.prototype.map.call(document.querySelectorAll('.permCheck:checked'), function (c) { return c.value; });
        if (role !== 'Admin' && !permissions.length) { toast('Tick at least one thing this login can access', 'error'); return; }
        if (u && u.id === state.user.id && role !== 'Admin') { toast('You can\'t remove your own Admin role', 'error'); return; }
        if (u) {
          const activeBox = document.getElementById('uActive');
          return gs('updateUser', state.user.role, { id: u.id, name: document.getElementById('uName').value.trim(), role: role, assignedBatchIds: assignedBatchIds,
              permissions: permissions, active: activeBox ? activeBox.checked : null, newPassword: password || null })
            .then(function (res) { finishUserSave(res); }).catch(function (e) { toast(e.message || String(e), 'error'); });
        }
        const name = document.getElementById('uName').value.trim();
        const username = document.getElementById('uUsername').value.trim();
        if (!name || !username || !password) { toast('Name, username, and password are required', 'error'); return; }
        return gs('createUser', state.user.role, { name: name, username: username, password: password, role: role, assignedBatchIds: assignedBatchIds, permissions: permissions })
          .then(function (res) { finishUserSave(res); }).catch(function (e) { toast(e.message || String(e), 'error'); });
      });
    toggleUserSections();
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
}
/** Picking a role pre-ticks that role's usual access — the admin then adjusts it as needed. */
function onUserRoleChange() {
  const role = document.getElementById('uRole').value;
  if (role === 'Teacher') {
    const preset = ROLE_PRESETS['Teacher'];
    document.querySelectorAll('.permCheck').forEach(function (c) { c.checked = preset.indexOf(c.value) !== -1; });
  }
  toggleUserSections();
}
/** Ticking "Edit student" etc. also ticks the Students page; unticking the page unticks its actions. */
function onPermChange(el) {
  if (el.checked && el.getAttribute('data-parent')) {
    const par = document.querySelector('.permCheck[value="' + el.getAttribute('data-parent') + '"]');
    if (par) par.checked = true;
  }
  if (!el.checked) document.querySelectorAll('.permCheck[data-parent="' + el.value + '"]').forEach(function (c) { c.checked = false; });
}
function toggleUserSections() {
  document.getElementById('customRoleWrap').style.display = document.getElementById('uRole').value === '__custom' ? 'block' : 'none';
  const isAdminRole = document.getElementById('uRole').value === 'Admin';
  document.getElementById('permWrap').style.display = isAdminRole ? 'none' : 'block';
  document.getElementById('batchPickerWrap').style.display = isAdminRole ? 'none' : 'block';
  document.getElementById('adminNote').style.display = isAdminRole ? 'block' : 'none';
}
function finishUserSave(res) {
  if (res.error) { toast(res.error, 'error'); return; }
  try { localStorage.removeItem(CACHE_PREFIX + 'users'); } catch (e) { }
  closeModal(); renderTeachers(); toast('Saved', 'success');
}
function deleteUserConfirm(el, id) {
  if (!confirm('Delete this login?')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteUser', state.user.role, id).then(function () { try { localStorage.removeItem(CACHE_PREFIX + 'users'); } catch (e) { } renderTeachers(); toast('Deleted', 'success'); });
  });
}


/* ================= HIGHLIGHT (a flag + remark everyone can see) ================= */

function studentById_(id) { return state.students.concat(state.discontinued || []).find(function (s) { return s.ID === id; }); }
function fmtShortDate_(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function highlightBlock_(s) {
  if (!s) return '';
  const on = !!s.Highlighted;
  return '<div class="hl-block" data-hl="' + s.ID + '">' +
    (on ? '<div class="hl-note">⚑ <b>' + esc(s.HighlightRemark || 'Highlighted') + '</b><span> — by ' + esc(s.HighlightedBy || '?') + (s.HighlightedAt ? ', ' + esc(fmtShortDate_(s.HighlightedAt)) : '') + '</span></div>' : '') +
    '<button type="button" class="hl-btn' + (on ? ' on' : '') + '" onclick="openHighlightModal(\'' + s.ID + '\')">⚑ ' + (on ? 'Edit highlight' : 'Highlight') + '</button></div>';
}
/** Redraws every highlight block for this student on screen (without reloading the sheet, so unsaved marks stay). */
function applyHighlightUi_(id) {
  const s = studentById_(id);
  if (!s) return;
  document.querySelectorAll('[data-hl="' + id + '"]').forEach(function (el) {
    const box = el.closest('.attendance-row') || el.closest('[data-student]');
    const tmp = document.createElement('div');
    tmp.innerHTML = highlightBlock_(s);
    el.replaceWith(tmp.firstChild);
    if (box) box.classList.toggle('hl-on', !!s.Highlighted);
  });
}
function setHighlightLocal_(id, h) {
  const s = studentById_(id);
  if (!s) return;
  s.Highlighted = !!h.highlighted; s.HighlightRemark = h.remark || ''; s.HighlightedBy = h.by || ''; s.HighlightedAt = h.at || '';
}
/** Picks up highlights made by other logins since this screen was opened. */
function syncHighlights() {
  gs('getHighlights').then(function (list) {
    const map = {};
    list.forEach(function (h) { map[h.ID] = h; });
    state.students.concat(state.discontinued || []).forEach(function (s) {
      const h = map[s.ID];
      setHighlightLocal_(s.ID, h ? { highlighted: true, remark: h.remark, by: h.by, at: h.at } : { highlighted: false });
    });
    const ids = {};
    document.querySelectorAll('[data-hl]').forEach(function (el) { ids[el.getAttribute('data-hl')] = true; });
    Object.keys(ids).forEach(applyHighlightUi_);
  }).catch(function () { /* older database without the highlight columns yet */ });
}
function openHighlightModal(id) {
  const s = studentById_(id);
  if (!s) return;
  const on = !!s.Highlighted;
  showModal('hlModal', (on ? 'Edit highlight — ' : 'Highlight — ') + s.Name,
    (on ? '<p class="muted" style="margin-top:0">Highlighted by <b>' + esc(s.HighlightedBy || '?') + '</b>' + (s.HighlightedAt ? ' on ' + esc(fmtShortDate_(s.HighlightedAt)) : '') + '. Everyone who opens this student sees it.</p>'
          : '<p class="muted" style="margin-top:0">Everyone who opens this student will see this remark, along with your name.</p>') +
    '<div class="field"><label>Why are you highlighting this student?</label><textarea id="hlRemark" rows="3" placeholder="e.g. Fee pending — ask before allowing in class">' + esc(s.HighlightRemark || '') + '</textarea></div>' +
    (on ? '<a class="link" style="color:#dc2626" onclick="removeHighlight(\'' + id + '\')">Remove highlight</a>' : ''),
    function () {
      const remark = document.getElementById('hlRemark').value.trim();
      if (!remark) { toast('Write the reason for the highlight', 'error'); return; }
      return gs('setStudentHighlight', state.user.role, id, true, remark).then(function (res) {
        setHighlightLocal_(id, res); closeModal(); applyHighlightUi_(id); toast('Highlighted', 'success');
      }).catch(function (e) { toast(e.message || String(e), 'error'); });
    }, on ? 'Update' : 'Highlight');
}
function removeHighlight(id) {
  gs('setStudentHighlight', state.user.role, id, false, '').then(function (res) {
    setHighlightLocal_(id, res); closeModal(); applyHighlightUi_(id); toast('Highlight removed', 'success');
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
}

/* ================= BATCH HISTORY (set previous batch) ================= */

function addDaysIso_(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function openBatchHistoryModal(id) {
  const s = state.students.find(function (x) { return x.ID === id; });
  if (!s) return;
  gs('getStudentBatchTrail', id).then(function (trail) {
    const cur = trail.find(function (t) { return t.batchId === s.BatchID; });
    const others = trail.filter(function (t) { return t.batchId !== s.BatchID; });
    const guess = others.length ? others[others.length - 1] : null;
    const suggestDate = cur ? cur.from : (guess ? addDaysIso_(guess.to, 1) : todayStr());
    const history = s.BatchHistory || [];
    const allBatches = state.batches.concat(state.closedBatches || []).filter(function (b) { return b.ID !== s.BatchID; });
    const range = function (a, b) { return (a ? fmtDate(a) : 'start') + ' – ' + (b ? fmtDate(b) : ''); };
    showModal('bhModal', 'Batch history — ' + s.Name,
      '<p style="margin-top:0">Now in <strong>' + esc(batchNameAny(s.BatchID)) + '</strong>' + (s.BatchSince ? ' since ' + fmtDate(s.BatchSince) : ' <span class="muted">(joining date not recorded)</span>') + '.</p>' +
      '<div class="field"><label>Attendance found in these batches</label>' +
        (trail.length ? trail.map(function (t) {
          return '<div class="contact-line" style="white-space:normal">' + esc(batchNameAny(t.batchId)) + ' — ' + range(t.from, t.to) + ' (' + t.count + ' records)' + (t.batchId === s.BatchID ? ' <span class="muted">· current</span>' : '') + '</div>';
        }).join('') : '<span class="muted">No attendance marked yet.</span>') + '</div>' +
      '<div class="field"><label>Saved previous batches</label>' +
        (history.length ? history.map(function (h, i) {
          return '<div class="contact-line" style="white-space:normal">' + esc(batchNameAny(h.batchId)) + ' — ' + range(h.from, h.to) + ' &nbsp; <a class="link" style="color:#dc2626" onclick="removeHistoryEntry(\'' + id + '\',' + i + ')">Remove</a></div>';
        }).join('') : '<span class="muted">None saved yet.</span>') + '</div>' +
      (allBatches.length
        ? '<hr style="border:none;border-top:1px solid var(--border);margin:14px 0">' +
          '<div class="field"><label>Previous batch</label><select id="bhPrev">' + allBatches.map(function (b) {
            return '<option value="' + b.ID + '"' + (guess && guess.batchId === b.ID ? ' selected' : '') + '>' + esc(b.Name) + (b.Closed ? ' (Closed)' : '') + '</option>';
          }).join('') + '</select></div>' +
          '<div class="field"><label>Moved out of the previous batch on (first day in ' + esc(batchNameAny(s.BatchID)) + ')</label><input type="date" id="bhDate" value="' + suggestDate + '"></div>' +
          '<div class="muted" style="font-size:12px">' + (guess ? 'Previous batch and date are suggested from the attendance already marked — change them if they are wrong. ' : '') +
          'Before this date the student shows on the previous batch\'s sheet; from this date on ' + esc(batchNameAny(s.BatchID)) + '\'s.</div>'
        : ''),
      function () {
        if (!allBatches.length) { closeModal(); return; }
        const prev = document.getElementById('bhPrev').value, date = document.getElementById('bhDate').value;
        if (!prev || !date) { toast('Pick the previous batch and the date', 'error'); return; }
        const t = trail.find(function (x) { return x.batchId === prev; });
        const kept = history.filter(function (h) { return h.batchId !== prev; });
        const latest = kept.every(function (h) { return h.to <= date; });
        return gs('saveBatchHistory', state.user.role, id, kept.concat([{ batchId: prev, from: t ? t.from : null, to: date }]), latest ? date : (s.BatchSince || null))
          .then(function () { closeModal(); return refreshData(); })
          .then(function () { clearAttendanceCaches(); renderStudents(); toast('Batch history saved', 'success'); })
          .catch(function (e) { toast(e.message || String(e), 'error'); });
      }, 'Save');
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
}
function removeHistoryEntry(id, index) {
  const s = state.students.find(function (x) { return x.ID === id; });
  if (!s) return;
  const history = (s.BatchHistory || []).filter(function (h, i) { return i !== index; });
  gs('saveBatchHistory', state.user.role, id, history, history.length ? s.BatchSince : null)
    .then(function () { closeModal(); return refreshData(); })
    .then(function () { clearAttendanceCaches(); renderStudents(); toast('Removed', 'success'); })
    .catch(function (e) { toast(e.message || String(e), 'error'); });
}

/* ================= ACTIVITY LOG (admin) ================= */

let activityPage = 0, activityToken = 0, activityTimer = null;
const ACTIVITY_PAGE_SIZE = 50;

function renderActivity() {
  const content = document.getElementById('content');
  activityPage = 0;
  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Login</label><select id="actUser" onchange="activityPage=0;loadActivity()"><option value="">All logins</option></select></div>' +
        '<div class="field"><label>From</label><input type="date" id="actFrom" onchange="activityPage=0;loadActivity()"></div>' +
        '<div class="field"><label>To</label><input type="date" id="actTo" onchange="activityPage=0;loadActivity()"></div>' +
        '<div class="field"><label>Search (action or student / batch name)</label><input id="actSearch" placeholder="e.g. discontinued, Riya, JEE" oninput="activitySearchTyped()"></div>' +
        '<div class="field"><button class="btn btn-secondary" onclick="loadActivity(this)">Reload</button></div>' +
      '</div>' +
      '<p class="muted" style="margin:0">Every change made through this app is recorded here with the login that made it. Entries cannot be edited or deleted from the app.</p>' +
    '</div>' +
    '<div class="card" id="activityArea"><div class="empty-state">Loading…</div></div>';
  gs('listUsers', state.user.role).then(function (users) {
    const sel = byId('actUser');
    if (!sel) return;
    users.forEach(function (u) { const o = document.createElement('option'); o.value = u.id; o.textContent = u.name + ' (' + u.role + ')'; sel.appendChild(o); });
  }).catch(function () { });
  loadActivity();
}
function activitySearchTyped() {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(function () { activityPage = 0; loadActivity(); }, 350);
}
function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}
function loadActivity(btn) {
  const token = ++activityToken;
  const filters = { userId: byId('actUser').value, from: byId('actFrom').value, to: byId('actTo').value, search: byId('actSearch').value.trim(), page: activityPage, pageSize: ACTIVITY_PAGE_SIZE };
  const task = gs('listActivity', filters).then(function (res) {
    if (token !== activityToken || state.view !== 'activity') return;
    const from = res.total ? activityPage * ACTIVITY_PAGE_SIZE + 1 : 0;
    const to = activityPage * ACTIVITY_PAGE_SIZE + res.rows.length;
    byId('activityArea').innerHTML =
      '<div class="flex-between" style="margin-bottom:10px"><div class="muted">' + (res.total ? 'Showing ' + from + '–' + to + ' of ' + res.total.toLocaleString() : 'No activity found') + '</div>' +
        '<div><button class="btn btn-secondary btn-sm" ' + (activityPage > 0 ? '' : 'disabled') + ' onclick="activityPage--;loadActivity()">← Newer</button> ' +
        '<button class="btn btn-secondary btn-sm" ' + (to < res.total ? '' : 'disabled') + ' onclick="activityPage++;loadActivity()">Older →</button></div></div>' +
      (res.rows.length ? renderTable(['When', 'Login', 'Role', 'Action', 'Details'], res.rows.map(function (r) {
        return [esc(fmtWhen(r.created_at)), '<strong>' + esc(r.user_name) + '</strong>', esc(r.role), esc(r.action), '<span style="font-size:12.5px">' + esc(r.details) + '</span>'];
      })) : '<div class="empty-state">Nothing recorded for these filters yet.</div>');
  }).catch(function (e) {
    if (token === activityToken && byId('activityArea')) byId('activityArea').innerHTML = '<div class="empty-state">Could not load the activity log. Run the latest schema.sql in Supabase first.</div>';
    toast(e.message || String(e), 'error');
  });
  if (btn) runWithLoading(btn, 'Loading…', function () { return task; });
}

/* ================= SETTINGS (admin) ================= */

function renderSettings() {
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card" style="max-width:420px">' +
      '<h3>Institute settings</h3>' +
      '<div class="field"><label>Institute name</label><input id="setName" value="' + esc(state.instituteName) + '"></div>' +
      '<div class="field"><label>Defaulter threshold (%)</label><input id="setThreshold" type="number" min="0" max="100" value="' + state.defaulterThreshold + '"></div>' +
      '<button class="btn btn-primary" onclick="saveSettings(this)">Save</button>' +
    '</div>';
}
function saveSettings(btn) {
  const task = gs('updateSettings', state.user.role, {
    instituteName: document.getElementById('setName').value.trim(),
    defaulterThreshold: Number(document.getElementById('setThreshold').value)
  }).then(function () { return refreshData(); }).then(function () { renderShell(); toast('Saved', 'success'); });
  runWithLoading(btn, 'Saving…', function () { return task; });
}

/* ================= CHANGE PASSWORD (all users) ================= */

function openChangePassword() {
  showModal('pwModal', 'Change password',
    '<div class="field"><label>Current password</label><input id="pwOld" type="password"></div>' +
    '<div class="field"><label>New password</label><input id="pwNew" type="password"></div>',
    function () {
      const oldP = document.getElementById('pwOld').value, newP = document.getElementById('pwNew').value;
      if (!newP || newP.length < 4) { toast('New password should be at least 4 characters', 'error'); return; }
      return gs('changeOwnPassword', state.user.id, oldP, newP).then(function (res) {
        if (res.error) { toast(res.error, 'error'); return; }
        closeModal(); toast('Password updated', 'success');
      });
    });
}

/* ================= MODAL HELPER ================= */

function showModal(id, title, bodyHtml, onSave, saveLabel) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = id;
  overlay.innerHTML =
    '<div class="modal"><h3>' + esc(title) + '</h3><div id="modalBody">' + bodyHtml + '</div>' +
      '<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="modalSaveBtn">' + esc(saveLabel || 'Save') + '</button></div></div>';
  document.body.appendChild(overlay);
  document.getElementById('modalSaveBtn').addEventListener('click', function () {
    runWithLoading(document.getElementById('modalSaveBtn'), 'Saving…', onSave);
  });
}
function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
}

/* ================= START ================= */

restoreSession();
