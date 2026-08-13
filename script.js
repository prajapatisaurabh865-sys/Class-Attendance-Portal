/* ==============================================================
   CLIENT APP — talks to the Apps Script backend via gs() below,
   which POSTs { fn, args } to your deployed Apps Script Web App URL.
================================================================= */

// 1. Deploy the backend-apps-script project as a Web App (Execute as: Me, Who has access: Anyone)
// 2. Paste that deployment URL (ends in /exec) below, between the quotes.
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwMHYucealGRS3rHaMCqIUBSNjdOSLpA2SrIb1JnSeSXL0G9BbKBmVp1Zmy4YyJCSt7/exec';

const state = {
  user: null,
  batches: [], subjects: [], students: [],
  instituteName: 'Attendance Manager', defaulterThreshold: 75,
  view: 'home'
};

/** GETs SCRIPT_URL?fn=...&args=... and returns a promise.
 *  Uses GET, not POST: Apps Script's /exec URL responds with a redirect, and
 *  browsers silently downgrade POST to GET (dropping the body) when following
 *  it — that's why login kept "doing nothing". GET survives the redirect fine. */
function gs(fnName) {
  const args = Array.prototype.slice.call(arguments, 1);
  const url = SCRIPT_URL + '?fn=' + encodeURIComponent(fnName) + '&args=' + encodeURIComponent(JSON.stringify(args));
  return fetch(url)
    .then(function (resp) { return resp.json(); })
    .then(function (json) {
      if (!json.ok) throw new Error(json.error || 'Server error');
      return json.result;
    });
}

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

/* ================= LOGIN ================= */

function renderLogin() {
  document.getElementById('app').innerHTML =
    '<div class="login-wrap"><div class="login-card">' +
      '<h1>' + esc(state.instituteName) + '</h1>' +
      '<p class="sub">Sign in to manage attendance</p>' +
      '<div id="loginError" class="error-text"></div>' +
      '<div class="field"><label>Username</label><input id="loginUser" autofocus></div>' +
      '<div class="field"><label>Password</label><input id="loginPass" type="password"></div>' +
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
    state.user = res;
    boot();
  }).catch(function (e) { document.getElementById('loginError').textContent = e.message || String(e); });
}

function logout() { state.user = null; renderLogin(); }

/* ================= BOOT + SHELL ================= */

function boot() {
  state.view = 'home';
  gsSWR('bootstrap', 'getBootstrapData', [], function (data) {
    state.batches = data.batches;
    state.subjects = data.subjects;
    state.students = data.students;
    state.instituteName = data.instituteName;
    state.defaulterThreshold = data.defaulterThreshold;
    if (!document.querySelector('.modal-overlay')) renderShell();
  });
}

function refreshData() {
  return gs('getBootstrapData').then(function (data) {
    state.batches = data.batches;
    state.subjects = data.subjects;
    state.students = data.students;
    const cached = getCache('bootstrap') || {};
    setCache('bootstrap', Object.assign({}, cached, { batches: data.batches, subjects: data.subjects, students: data.students }));
  });
}

const NAV = [
  { id: 'home', label: 'Dashboard', roles: ['Admin', 'Teacher'] },
  { id: 'mark', label: 'Mark Attendance', roles: ['Admin', 'Teacher'] },
  { id: 'records', label: 'Records', roles: ['Admin', 'Teacher'] },
  { id: 'reports', label: 'Reports', roles: ['Admin', 'Teacher'] },
  { id: 'batches', label: 'Batches', roles: ['Admin'] },
  { id: 'subjects', label: 'Subjects', roles: ['Admin'] },
  { id: 'students', label: 'Students', roles: ['Admin'] },
  { id: 'teachers', label: 'Teachers & Logins', roles: ['Admin'] },
  { id: 'settings', label: 'Settings', roles: ['Admin'] }
];

function renderShell() {
  const navHtml = NAV.filter(function (n) { return n.roles.indexOf(state.user.role) !== -1; })
    .map(function (n) {
      return '<div class="nav-item' + (state.view === n.id ? ' active' : '') + '" onclick="setView(\'' + n.id + '\')">' + n.label + '</div>';
    }).join('');

  document.getElementById('app').innerHTML =
    '<div class="sidebar">' +
      '<div class="brand">' + esc(state.instituteName) + '<small>Attendance Manager</small></div>' +
      navHtml +
      '<div class="sidebar-footer">' + esc(state.user.name) + ' &middot; ' + esc(state.user.role) +
        '<br><a class="link" style="color:#93c5fd" onclick="logout()">Sign out</a></div>' +
    '</div>' +
    '<div class="main">' +
      '<div class="topbar"><h2 id="viewTitle"></h2>' +
        '<a class="link" onclick="openChangePassword()">Change password</a>' +
      '</div>' +
      '<div class="content" id="content"></div>' +
    '</div>';
  renderView();
}

function setView(v) { state.view = v; renderShell(); }

function renderView() {
  const titles = { home: 'Dashboard', mark: 'Mark Attendance', records: 'Attendance Records', reports: 'Reports',
    batches: 'Batches', subjects: 'Subjects', students: 'Students', teachers: 'Teachers & Logins', settings: 'Settings' };
  document.getElementById('viewTitle').textContent = titles[state.view] || '';
  const renderers = { home: renderHome, mark: renderMark, records: renderRecords, reports: renderReports,
    batches: renderBatches, subjects: renderSubjects, students: renderStudents, teachers: renderTeachers, settings: renderSettings };
  (renderers[state.view] || renderHome)();
}

function myBatches() {
  if (state.user.role === 'Admin') return state.batches;
  return state.batches.filter(function (b) { return state.user.assignedBatchIds.indexOf(b.ID) !== -1; });
}

/* ================= HOME ================= */

function renderHome() {
  const content = document.getElementById('content');
  const cached = getCache('defaulters');
  if (!cached) content.innerHTML = '<div class="empty-state">Loading…</div>';
  gsSWR('defaulters', 'getDefaultersReport', [{}], function (defaulters) {
    if (state.view !== 'home') return; // user already navigated away
    content.innerHTML =
      '<div class="stat-grid">' +
        statCard(myBatches().length, 'Batches') +
        statCard(state.students.length, 'Active students') +
        statCard(state.subjects.length, 'Subjects') +
        statCard(defaulters.length, 'Students below ' + state.defaulterThreshold + '% attendance') +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><h3>Below-threshold students</h3><a class="link" onclick="setView(\'reports\')">Full reports →</a></div>' +
        (defaulters.length ? renderTable(['Student', 'Roll No', 'Sessions', 'Present', '%'],
          defaulters.slice(0, 8).map(function (d) { return [d.studentName, d.rollNo, d.totalSessions, d.present, badgePct(d.percentage)]; }))
          : '<div class="empty-state">No defaulters — nice work 🎉</div>') +
      '</div>';
  });
}

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

function renderMark() {
  const batches = myBatches();
  const content = document.getElementById('content');
  if (!batches.length) { content.innerHTML = '<div class="empty-state">You are not assigned to any batch yet. Ask your admin to assign one.</div>'; return; }

  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="markBatch" onchange="onMarkBatchChange()">' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>Subject</label><select id="markSubject"></select></div>' +
        '<div class="field"><label>Date</label><input type="date" id="markDate" value="' + todayStr() + '"></div>' +
        '<div class="field"><button class="btn btn-primary" onclick="loadSession(this)">Load session</button></div>' +
      '</div>' +
    '</div>' +
    '<div id="sessionArea"></div>';
  onMarkBatchChange();
}

function onMarkBatchChange() {
  const batchId = document.getElementById('markBatch').value;
  const subjects = state.subjects.filter(function (s) { return s.BatchID === batchId; });
  const sel = document.getElementById('markSubject');
  const allOption = '<option value="__ALL__">All Subjects</option>';
  sel.innerHTML = allOption + subjects.map(function (s) { return '<option value="' + s.ID + '">' + esc(s.Name) + '</option>'; }).join('');
  sel.value = '__ALL__'; // always defaults here — marking one subject differently doesn't change this default
}

function loadSession(btn) {
  const batchId = document.getElementById('markBatch').value;
  const subjectId = document.getElementById('markSubject').value;
  const date = document.getElementById('markDate').value;
  if (!subjectId || !date) { toast('Pick a subject and date first', 'error'); return; }

  const roster = state.students.filter(function (s) { return s.BatchID === batchId; });
  if (!roster.length) {
    document.getElementById('sessionArea').innerHTML = '<div class="empty-state">No students in this batch yet.</div>';
    return;
  }

  const isAllSubjects = subjectId === '__ALL__';
  const renderRoster = function (existingByStudent) {
    const rows = roster.map(function (s) {
      const status = existingByStudent[s.ID] || 'Present';
      const searchBlob = (s.Name + ' ' + (s.RollNo || '') + ' ' + (s.Phone || '')).toLowerCase();
      return '<div class="attendance-row" data-student="' + s.ID + '" data-search="' + esc(searchBlob) + '">' +
        '<div>' + esc(s.Name) + (s.RollNo ? ' <span class="muted">(' + esc(s.RollNo) + ')</span>' : '') + '</div>' +
        '<div class="status-toggle">' +
          ['Present', 'Absent', 'Late'].map(function (st) {
            return '<button type="button" class="status-btn' + (status === st ? ' selected ' + st.toLowerCase() : '') +
              '" onclick="setStatus(this,\'' + st + '\')" data-status="' + st + '">' + st + '</button>';
          }).join('') +
        '</div></div>';
    }).join('');

    const heading = isAllSubjects
      ? roster.length + ' students — marking ALL subjects at once'
      : roster.length + ' students';
    const subNote = isAllSubjects
      ? '<p class="muted" style="margin:-8px 0 14px">This marks every subject for this batch on this date in one go. To make one student absent in just one subject, switch Subject above to that specific subject, mark it, and save — it won\'t affect the others.</p>'
      : '';

    document.getElementById('sessionArea').innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h3>' + heading + '</h3>' +
          '<div><button class="btn btn-secondary btn-sm" onclick="markAll(\'Present\')">All present</button> ' +
          '<button class="btn btn-secondary btn-sm" onclick="markAll(\'Absent\')">All absent</button></div></div>' +
        subNote +
        '<div class="field" style="max-width:320px"><input type="text" id="rosterSearch" placeholder="Search by name, roll no, or phone…" oninput="filterRoster()"></div>' +
        '<div id="rosterList">' + rows + '</div>' +
        '<div id="rosterEmpty" class="empty-state" style="display:none">No students match your search.</div>' +
        '<div style="margin-top:16px;text-align:right"><button class="btn btn-primary" onclick="saveSession(this)">Save attendance</button></div>' +
      '</div>';
  };

  document.getElementById('sessionArea').innerHTML = '<div class="empty-state">Loading session…</div>';
  runWithLoading(btn, 'Loading…', function () {
    if (isAllSubjects) {
      // Nothing single-subject to prefill from — start everyone at Present for this fresh bulk pass.
      renderRoster({});
      return null;
    }
    return gs('getSessionAttendance', batchId, subjectId, date).then(function (existing) {
      const existingByStudent = {};
      existing.forEach(function (r) { existingByStudent[r.StudentID] = r.Status; });
      renderRoster(existingByStudent);
    });
  });
}

function setStatus(btn, status) {
  const group = btn.parentElement;
  Array.prototype.forEach.call(group.children, function (b) { b.classList.remove('selected', 'present', 'absent', 'late'); });
  btn.classList.add('selected', status.toLowerCase());
}
function markAll(status) {
  document.querySelectorAll('.attendance-row').forEach(function (row) {
    const btn = row.querySelector('[data-status="' + status + '"]');
    setStatus(btn, status);
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
  const batchId = document.getElementById('markBatch').value;
  const subjectId = document.getElementById('markSubject').value;
  const date = document.getElementById('markDate').value;
  const records = Array.prototype.map.call(document.querySelectorAll('.attendance-row'), function (row) {
    const selected = row.querySelector('.status-btn.selected');
    return { studentId: row.getAttribute('data-student'), status: selected ? selected.getAttribute('data-status') : 'Present' };
  });

  const isAllSubjects = subjectId === '__ALL__';
  const targetSubjectIds = isAllSubjects
    ? state.subjects.filter(function (s) { return s.BatchID === batchId; }).map(function (s) { return s.ID; })
    : [subjectId];

  if (isAllSubjects && !targetSubjectIds.length) {
    toast('This batch has no subjects yet — add one from Subjects first', 'error');
    return;
  }

  const task = Promise.all(targetSubjectIds.map(function (sid) {
    return gs('submitAttendance', state.user, date, batchId, sid, records);
  })).then(function () {
    clearAttendanceCaches();
    toast('Attendance saved for ' + records.length + ' students' + (isAllSubjects ? ' across ' + targetSubjectIds.length + ' subjects' : ''), 'success');
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
  const batches = myBatches();
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Batch</label><select id="recBatch"><option value="">All</option>' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>Student</label><select id="recStudent"><option value="">All</option>' +
          state.students.map(function (s) { return '<option value="' + s.ID + '">' + esc(s.Name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>From</label><input type="date" id="recFrom"></div>' +
        '<div class="field"><label>To</label><input type="date" id="recTo"></div>' +
        '<div class="field"><button class="btn btn-primary" onclick="loadRecords()">Filter</button></div>' +
      '</div>' +
      '<div class="flex-between"><div id="recCount" class="muted"></div>' +
        '<div class="export-row">' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'csv\')">Export CSV</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'xlsx\')">Export Excel</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'pdf\')">Export PDF</button>' +
        '</div>' +
      '</div>' +
      '<div id="recTable" style="margin-top:12px"></div>' +
    '</div>';
  loadRecords();
}

let lastExportData = null; // { title, headers, rows }

function loadRecords() {
  const filters = {
    batchId: document.getElementById('recBatch').value,
    studentId: document.getElementById('recStudent').value,
    from: document.getElementById('recFrom').value,
    to: document.getElementById('recTo').value
  };
  const cacheKey = 'records:' + JSON.stringify(filters);
  if (!getCache(cacheKey)) document.getElementById('recTable').innerHTML = '<div class="empty-state">Loading…</div>';
  gsSWR(cacheKey, 'getAttendanceRecords', [filters], function (records) {
    if (state.view !== 'records') return;
    if (state.user.role !== 'Admin') {
      const allowedBatchNames = myBatches().map(function (b) { return b.Name; });
      records = records.filter(function (r) { return allowedBatchNames.indexOf(r.batchName) !== -1; });
    }
    document.getElementById('recCount').textContent = records.length + ' record(s)';
    const headers = ['Date', 'Batch', 'Subject', 'Student', 'Roll No', 'Status', 'Marked By'];
    const rows = records.map(function (r) { return [fmtDate(r.date), r.batchName, r.subjectName, r.studentName, r.rollNo, r.status, r.markedBy]; });
    lastExportData = { title: 'Attendance_Records', headers: headers, rows: rows };
    document.getElementById('recTable').innerHTML = records.length
      ? renderTable(headers, rows.map(function (row) {
          return row.slice(0, 5).concat([statusBadge(row[5]), row[6]]);
        }))
      : '<div class="empty-state">No records match these filters.</div>';
  });
}
function statusBadge(status) {
  const cls = status === 'Present' ? 'badge-success' : status === 'Late' ? 'badge-warn' : 'badge-danger';
  return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
}

function exportCurrent(format) {
  if (!lastExportData || !lastExportData.rows.length) { toast('Nothing to export yet', 'error'); return; }
  toast('Preparing ' + format.toUpperCase() + '…');
  gs('exportTable', format, lastExportData.title, lastExportData.headers, lastExportData.rows).then(function (res) {
    if (res.error) { toast(res.error, 'error'); return; }
    downloadBase64(res.base64, res.mimeType, res.filename);
  }).catch(function (e) { toast(e.message || String(e), 'error'); });
}

function downloadBase64(base64, mimeType, filename) {
  const link = document.createElement('a');
  link.href = 'data:' + mimeType + ';base64,' + base64;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ================= REPORTS ================= */

function renderReports() {
  const batches = myBatches();
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="filters">' +
        '<div class="field"><label>Report type</label><select id="repType" onchange="loadReport()">' +
          '<option value="student">Student-wise %</option>' +
          '<option value="batch">Batch/session-wise</option>' +
          '<option value="defaulters">Defaulters (below ' + state.defaulterThreshold + '%)</option>' +
        '</select></div>' +
        '<div class="field"><label>Batch</label><select id="repBatch" onchange="loadReport()"><option value="">All</option>' +
          batches.map(function (b) { return '<option value="' + b.ID + '">' + esc(b.Name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>From</label><input type="date" id="repFrom" onchange="loadReport()"></div>' +
        '<div class="field"><label>To</label><input type="date" id="repTo" onchange="loadReport()"></div>' +
      '</div>' +
      '<div class="flex-between"><div id="repCount" class="muted"></div>' +
        '<div class="export-row">' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'csv\')">Export CSV</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'xlsx\')">Export Excel</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="exportCurrent(\'pdf\')">Export PDF</button>' +
        '</div>' +
      '</div>' +
      '<div id="repTable" style="margin-top:12px"></div>' +
    '</div>';
  loadReport();
}

function loadReport() {
  const type = document.getElementById('repType').value;
  const filters = {
    batchId: document.getElementById('repBatch').value,
    from: document.getElementById('repFrom').value,
    to: document.getElementById('repTo').value
  };
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
    document.getElementById('repTable').innerHTML = data.length ? renderTable(headers, displayRows) : '<div class="empty-state">No data for this filter.</div>';
  });
}

/* ================= BATCHES (admin) ================= */

function renderBatches() {
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Batches</h3><button class="btn btn-primary btn-sm" onclick="openBatchModal()">+ Add batch</button></div>' +
      renderTable(['Name', 'Description', ''], state.batches.map(function (b) {
        return [esc(b.Name), esc(b.Description || ''),
          '<a class="link" onclick=\'openBatchModal(' + JSON.stringify(b.ID) + ')\'>Edit</a> &nbsp; ' +
          '<a class="link" style="color:#dc2626" onclick="deleteBatchConfirm(this,\'' + b.ID + '\')">Delete</a>'];
      })) +
    '</div>';
}

function openBatchModal(id) {
  const batch = id ? state.batches.find(function (b) { return b.ID === id; }) : null;
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
function deleteBatchConfirm(el, id) {
  if (!confirm('Delete this batch? Students/subjects in it will remain but be unassigned.')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteBatch', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderBatches(); toast('Deleted', 'success'); });
  });
}

/* ================= SUBJECTS (admin) ================= */

function renderSubjects() {
  const batchName = function (id) { const b = state.batches.find(function (x) { return x.ID === id; }); return b ? b.Name : '(unassigned)'; };
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

/* ================= STUDENTS (admin) ================= */

function renderStudents() {
  const content = document.getElementById('content');
  content.innerHTML =
    '<div class="card">' +
      '<div class="card-header"><h3>Students</h3><div>' +
        '<button class="btn btn-secondary btn-sm" onclick="openBulkImport()">Bulk import</button> ' +
        '<button class="btn btn-primary btn-sm" onclick="openStudentModal()">+ Add student</button></div></div>' +
      '<div class="field" style="max-width:320px"><input type="text" id="studentSearch" placeholder="Search by name, roll no, or phone…" oninput="renderStudentsTable()"></div>' +
      '<div id="studentsTableArea"></div>' +
    '</div>';
  renderStudentsTable();
}
function renderStudentsTable() {
  const batchName = function (id) { const b = state.batches.find(function (x) { return x.ID === id; }); return b ? b.Name : '(unassigned)'; };
  const q = (document.getElementById('studentSearch').value || '').trim().toLowerCase();
  const filtered = !q ? state.students : state.students.filter(function (s) {
    return String(s.Name || '').toLowerCase().indexOf(q) !== -1 ||
      String(s.RollNo || '').toLowerCase().indexOf(q) !== -1 ||
      String(s.Phone || '').toLowerCase().indexOf(q) !== -1;
  });
  document.getElementById('studentsTableArea').innerHTML = filtered.length
    ? renderTable(['Name', 'Roll No', 'Batch', 'Phone', ''], filtered.map(function (s) {
        return [esc(s.Name), esc(s.RollNo || ''), esc(batchName(s.BatchID)), esc(s.Phone || ''),
          '<a class="link" onclick=\'openStudentModal(' + JSON.stringify(s.ID) + ')\'>Edit</a> &nbsp; ' +
          '<a class="link" style="color:#dc2626" onclick="deleteStudentConfirm(this,\'' + s.ID + '\')">Delete</a>'];
      }))
    : '<div class="empty-state">No students match "' + esc(q) + '".</div>';
}
function openStudentModal(id) {
  const student = id ? state.students.find(function (s) { return s.ID === id; }) : null;
  showModal('studentModal', (student ? 'Edit' : 'Add') + ' student',
    '<div class="field-row">' +
      '<div class="field"><label>Name</label><input id="stName" value="' + esc(student ? student.Name : '') + '"></div>' +
      '<div class="field"><label>Roll No</label><input id="stRoll" value="' + esc(student ? student.RollNo : '') + '"></div>' +
    '</div>' +
    '<div class="field"><label>Batch</label><select id="stBatch">' +
      state.batches.map(function (b) { return '<option value="' + b.ID + '"' + (student && student.BatchID === b.ID ? ' selected' : '') + '>' + esc(b.Name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Phone</label><input id="stPhone" value="' + esc(student ? student.Phone : '') + '"></div>' +
      '<div class="field"><label>Email</label><input id="stEmail" value="' + esc(student ? student.Email : '') + '"></div>' +
    '</div>',
    function () {
      const data = {
        name: document.getElementById('stName').value.trim(),
        rollNo: document.getElementById('stRoll').value.trim(),
        batchId: document.getElementById('stBatch').value,
        phone: document.getElementById('stPhone').value.trim(),
        email: document.getElementById('stEmail').value.trim()
      };
      if (!data.name) { toast('Name is required', 'error'); return; }
      const call = student ? gs('updateStudent', state.user.role, Object.assign({ id: student.ID }, data)) : gs('createStudent', state.user.role, data);
      return call.then(function () { closeModal(); return refreshData(); }).then(function () { renderStudents(); toast('Saved', 'success'); });
    });
}
function deleteStudentConfirm(el, id) {
  if (!confirm('Delete this student? Their past attendance history is kept.')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteStudent', state.user.role, id).then(function () { return refreshData(); }).then(function () { renderStudents(); toast('Deleted', 'success'); });
  });
}
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

/* ================= TEACHERS & LOGINS (admin) ================= */

function renderTeachers() {
  const content = document.getElementById('content');
  const cached = getCache('users');
  if (!cached) content.innerHTML = '<div class="card"><div class="empty-state">Loading…</div></div>';
  gsSWR('users', 'listUsers', [state.user.role], function (users) {
    if (state.view !== 'teachers') return;
    const batchNames = function (ids) { return ids.map(function (id) { const b = state.batches.find(function (x) { return x.ID === id; }); return b ? b.Name : ''; }).filter(Boolean).join(', ') || '—'; };
    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><h3>Teachers &amp; logins</h3><button class="btn btn-primary btn-sm" onclick="openUserModal()">+ Add login</button></div>' +
        renderTable(['Name', 'Username', 'Role', 'Assigned batches', 'Status', ''], users.map(function (u) {
          return [esc(u.name), esc(u.username), esc(u.role), esc(batchNames(u.assignedBatchIds)),
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
    showModal('userModal', (u ? 'Edit' : 'Add') + ' login',
      '<div class="field"><label>Name</label><input id="uName" value="' + esc(u ? u.name : '') + '"></div>' +
      '<div class="field"><label>Username</label><input id="uUsername" value="' + esc(u ? u.username : '') + '"' + (u ? ' disabled' : '') + '></div>' +
      '<div class="field"><label>' + (u ? 'New password (leave blank to keep current)' : 'Password') + '</label><input id="uPassword" type="password"></div>' +
      '<div class="field"><label>Role</label><select id="uRole" onchange="toggleBatchPicker()">' +
        '<option value="Teacher"' + (u && u.role === 'Teacher' ? ' selected' : '') + '>Teacher</option>' +
        '<option value="Admin"' + (u && u.role === 'Admin' ? ' selected' : '') + '>Admin</option>' +
      '</select></div>' +
      '<div class="field" id="batchPickerWrap"><label>Assigned batches (teachers only)</label>' +
        state.batches.map(function (b) {
          const checked = u && u.assignedBatchIds.indexOf(b.ID) !== -1;
          return '<label style="font-weight:400;display:flex;gap:6px;align-items:center;margin-bottom:4px">' +
            '<input type="checkbox" class="batchCheck" value="' + b.ID + '"' + (checked ? ' checked' : '') + '> ' + esc(b.Name) + '</label>';
        }).join('') +
      '</div>',
      function () {
        const assignedBatchIds = Array.prototype.map.call(document.querySelectorAll('.batchCheck:checked'), function (c) { return c.value; });
        const role = document.getElementById('uRole').value;
        const password = document.getElementById('uPassword').value;
        if (u) {
          return gs('updateUser', state.user.role, { id: u.id, name: document.getElementById('uName').value.trim(), role: role, assignedBatchIds: assignedBatchIds, newPassword: password || null })
            .then(function (res) { finishUserSave(res); });
        } else {
          const name = document.getElementById('uName').value.trim();
          const username = document.getElementById('uUsername').value.trim();
          if (!name || !username || !password) { toast('Name, username, and password are required', 'error'); return; }
          return gs('createUser', state.user.role, { name: name, username: username, password: password, role: role, assignedBatchIds: assignedBatchIds })
            .then(function (res) { finishUserSave(res); });
        }
      });
    toggleBatchPicker();
  });
}
function finishUserSave(res) {
  if (res.error) { toast(res.error, 'error'); return; }
  closeModal(); renderTeachers(); toast('Saved', 'success');
}
function toggleBatchPicker() {
  const role = document.getElementById('uRole').value;
  document.getElementById('batchPickerWrap').style.display = role === 'Admin' ? 'none' : 'block';
}
function deleteUserConfirm(el, id) {
  if (!confirm('Delete this login?')) return;
  runWithLoading(el, 'Deleting…', function () {
    return gs('deleteUser', state.user.role, id).then(function () { renderTeachers(); toast('Deleted', 'success'); });
  });
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

function showModal(id, title, bodyHtml, onSave) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = id;
  overlay.innerHTML =
    '<div class="modal"><h3>' + esc(title) + '</h3><div id="modalBody">' + bodyHtml + '</div>' +
      '<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="modalSaveBtn">Save</button></div></div>';
  document.body.appendChild(overlay);
  document.getElementById('modalSaveBtn').addEventListener('click', function () {
    runWithLoading(document.getElementById('modalSaveBtn'), 'Saving…', onSave);
  });
}
function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
}

/* ================= START ================= */

renderLogin();
