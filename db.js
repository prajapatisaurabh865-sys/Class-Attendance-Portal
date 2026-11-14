/* ==================================================================
   DB.JS — Supabase-backed data layer
   ==================================================================
   This replaces the old Apps Script backend entirely. It exposes the
   same gs(fnName, ...args) function the rest of script.js already
   calls everywhere, so nothing else in script.js had to change.

   SETUP: paste your Supabase project URL and anon (public) key below.
   Find them in your Supabase project: Settings → API.
================================================================= */

const SUPABASE_URL = 'https://ulnxboxsywxjngxfhhzf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsbnhib3hzeXd4am5neGZoaHpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NDgwNzksImV4cCI6MjEwNTIyNDA3OX0.a0mREYmfUQ-XPPMfWUGVI2rgN0S7nD9hfJnQnKIDKRU';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function currentUser_() { return (typeof state !== 'undefined' && state.user) ? state.user : null; }
function can_(perm) {
  const u = currentUser_();
  if (!u) return false;
  if (u.role === 'Admin') return true;
  return Array.isArray(u.permissions) && u.permissions.indexOf(perm) !== -1;
}
function requirePerm_(perm) { if (!can_(perm)) throw new Error('You do not have permission to do this.'); }
function requireAdmin_() {
  const u = currentUser_();
  if (!u || u.role !== 'Admin') throw new Error('Only an admin can do this.');
}
function assertBatchAccess_(user, batchId) {
  if (user.role === 'Admin') return;
  if ((user.assignedBatchIds || []).indexOf(batchId) === -1) throw new Error('You are not assigned to this batch.');
}
function throwIfError_(error) { if (error) throw new Error(error.message || String(error)); }
function uid_() { return crypto.randomUUID(); }

/** Real CSV parser over the WHOLE text (not line by line), so a quoted cell that
 *  contains a line-break — e.g. two phone numbers on separate lines, or a
 *  multi-line Reason — stays one cell instead of splitting the row in two.
 *  Returns an array of rows, each an array of trimmed cell strings. */
function parseCsv_(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur.trim()); cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some(function (x) { return x !== ''; })) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur.trim());
  if (row.some(function (x) { return x !== ''; })) rows.push(row);
  return rows;
}

/** Accepts dd/mm/yyyy, d-m-yy, dd.mm.yy etc. (two-digit years mean 20yy) and
 *  returns yyyy-mm-dd — or null if it isn't a real calendar date. */
function parseDmyDate_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function normalizeStatus_(v) {
  v = String(v || '').trim().toLowerCase();
  if (!v) return null;
  if (['present', 'p', '1', 'yes', 'y'].indexOf(v) !== -1) return 'Present';
  if (['absent', 'a', '0', 'no', 'n'].indexOf(v) !== -1) return 'Absent';
  if (['late', 'l'].indexOf(v) !== -1) return 'Late';
  return null;
}
/** Cells like "Sunday", "Holiday", "Week Off", "No Class" mean no class was held —
 *  expected, not an error, so they're skipped quietly instead of being reported. */
function isNoClassMarker_(v) {
  return /^(sunday|holiday|week\s*off|no\s*class|off|teacher'?s\s*day)$/i.test(String(v || '').trim());
}
/** Phone cells sometimes hold two numbers on separate lines — keep both, on one line. */
function cleanPhone_(s) {
  return String(s || '').replace(/\s*[\r\n;]+\s*/g, ', ').trim();
}

/** Supabase returns at most 1000 rows per request, silently. This pages through
 *  until everything is fetched. makeQuery must build a fresh query each call. */
async function fetchAll_(makeQuery, pageSize) {
  pageSize = pageSize || 1000;
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    throwIfError_(error);
    for (let i = 0; i < data.length; i++) all.push(data[i]);
    if (data.length < pageSize) break;
  }
  return all;
}

/** Inserts a big array in chunks (a single request with tens of thousands of rows
 *  would be rejected), a few chunks at a time. onProgress(doneRows) is optional. */
async function insertChunked_(table, rows, opts) {
  opts = opts || {};
  const size = opts.size || 1000, parallel = opts.parallel || 3;
  let next = 0, done = 0;
  async function worker() {
    while (next < rows.length) {
      const start = next; next += size;
      const chunk = rows.slice(start, start + size);
      const q = opts.ignoreDuplicates
        ? sb.from(table).upsert(chunk, { onConflict: opts.onConflict, ignoreDuplicates: true })
        : sb.from(table).insert(chunk);
      const { error } = await q;
      throwIfError_(error);
      done += chunk.length;
      if (opts.onProgress) opts.onProgress(done);
    }
  }
  const workers = [];
  for (let i = 0; i < parallel; i++) workers.push(worker());
  await Promise.all(workers);
}

/* -------- row → the same shape script.js already expects -------- */
function rowToBatch_(r) { return { ID: r.id, Name: r.name, Description: r.description || '', Active: r.active, Closed: !!r.closed, ClosedAt: r.closed_at || '' }; }
function rowToSubject_(r) { return { ID: r.id, Name: r.name, BatchID: r.batch_id, Active: r.active }; }
const CONTACT_LABELS_ = ['Student', 'Father', 'Mother', 'Guardian', 'Brother', 'Sister', 'Uncle', 'Aunt', 'Grandparent', 'Other'];
/** Ordered phone numbers of a student: the order IS the calling order (first = call first). */
function normalizeContacts_(r) {
  let c = r ? r.contacts : null;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
  if (!Array.isArray(c) || !c.length) {
    c = [];
    if (r && r.phone) c.push({ label: 'Student', number: r.phone });
    if (r && r.parent_phone) c.push({ label: 'Parent', number: r.parent_phone });
  }
  return c.filter(function (x) { return x && String(x.number || '').trim(); })
    .map(function (x) { return { label: String(x.label || 'Other'), number: String(x.number).trim() }; });
}
/** Keeps the old single phone / parent_phone columns in step with the contact list (used by search, CSV, older screens). */
function contactPatch_(contacts) {
  const list = (contacts || []).filter(function (x) { return x && String(x.number || '').trim(); })
    .map(function (x) { return { label: String(x.label || 'Other'), number: String(x.number).trim() }; });
  const own = list.find(function (x) { return x.label === 'Student'; });
  const other = list.find(function (x) { return x.label !== 'Student'; });
  return { contacts: list, phone: own ? own.number : '', parent_phone: other ? other.number : '' };
}

function rowToStudent_(r) {
  return {
    ID: r.id, Name: r.name, RollNo: r.roll_no || '', BatchID: r.batch_id,
    Phone: r.phone || '', Email: r.email || '', ParentPhone: r.parent_phone || '', Contacts: normalizeContacts_(r),
    AdmissionDate: r.admission_date || '', Active: r.active,
    Discontinued: !!r.discontinued, DiscontinuedAt: r.discontinued_at || '', DiscontinueReason: r.discontinue_reason || ''
  };
}

const RECORD_COLUMNS_ = 'id, date, status, marked_by, remark, reason, color, batches(name), subjects(name), students(name, roll_no, phone, parent_phone)';
function buildRecordsQuery_(filters, withCount) {
  let q = sb.from('attendance').select(RECORD_COLUMNS_, withCount ? { count: 'exact' } : undefined);
  if (filters.batchId) q = q.eq('batch_id', filters.batchId);
  else if (filters.batchIds) q = q.in('batch_id', filters.batchIds.length ? filters.batchIds : ['00000000-0000-0000-0000-000000000000']); // no batches assigned → no rows
  if (filters.subjectId) q = q.eq('subject_id', filters.subjectId);
  if (filters.studentId) q = q.eq('student_id', filters.studentId);
  if (filters.from) q = q.gte('date', filters.from);
  if (filters.to) q = q.lte('date', filters.to);
  return q;
}
function rowToRecord_(r) {
  return {
    id: r.id, date: r.date,
    batchName: r.batches ? r.batches.name : '(deleted batch)',
    subjectName: r.subjects ? r.subjects.name : '(deleted subject)',
    studentName: r.students ? r.students.name : '(deleted student)',
    rollNo: r.students ? (r.students.roll_no || '') : '',
    studentPhone: r.students ? (r.students.phone || '') : '',
    parentPhone: r.students ? (r.students.parent_phone || '') : '',
    status: r.status, markedBy: r.marked_by || '', remark: r.remark || '', reason: r.reason || '', color: r.color || ''
  };
}

/** Non-admin staff only ever see report rows for the batches they're assigned to. */
function restrictToMyBatches_(rows) {
  const u = currentUser_();
  if (!u || u.role === 'Admin') return rows;
  const ids = u.assignedBatchIds || [];
  return rows.filter(function (r) { return !r.batchId || ids.indexOf(r.batchId) !== -1; });
}

function studentWiseFromRecords_(records) {
  const byStudent = {};
  records.forEach(function (r) {
    const key = r.studentName + '||' + r.rollNo;
    if (!byStudent[key]) byStudent[key] = { studentName: r.studentName, rollNo: r.rollNo, total: 0, present: 0 };
    byStudent[key].total++;
    if (r.status === 'Present' || r.status === 'Late') byStudent[key].present++;
  });
  return Object.keys(byStudent).map(function (k) {
    const s = byStudent[k];
    return {
      studentName: s.studentName, rollNo: s.rollNo, totalSessions: s.total, present: s.present,
      absent: s.total - s.present, percentage: s.total ? Math.round((s.present / s.total) * 1000) / 10 : 0
    };
  }).sort(function (a, b) { return a.percentage - b.percentage; });
}
function batchWiseFromRecords_(records) {
  const byKey = {};
  records.forEach(function (r) {
    const key = r.date + '||' + r.batchName + '||' + r.subjectName;
    if (!byKey[key]) byKey[key] = { date: r.date, batchName: r.batchName, subjectName: r.subjectName, present: 0, absent: 0, late: 0, total: 0 };
    byKey[key].total++;
    if (r.status === 'Present') byKey[key].present++;
    else if (r.status === 'Absent') byKey[key].absent++;
    else if (r.status === 'Late') byKey[key].late++;
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

const API = {

  /* ---------------- AUTH ---------------- */

  login: async function (username, password) {
    const { data, error } = await sb.rpc('rpc_login', { p_username: username, p_password: password });
    throwIfError_(error);
    return data;
  },
  changeOwnPassword: async function (userId, oldPassword, newPassword) {
    const { data, error } = await sb.rpc('rpc_change_password', { p_user_id: userId, p_old_password: oldPassword, p_new_password: newPassword });
    throwIfError_(error);
    return data;
  },
  /** Re-checks a saved login against the database (still active? role / access changed?). */
  getSessionUser: async function (userId) {
    const { data, error } = await sb.rpc('rpc_get_session_user', { p_user_id: userId });
    throwIfError_(error);
    return data;
  },
  listUsers: async function (role) {
    requireAdmin_();
    const { data, error } = await sb.rpc('rpc_list_users');
    throwIfError_(error);
    return data;
  },
  createUser: async function (role, data) {
    requireAdmin_();
    const { data: res, error } = await sb.rpc('rpc_create_user', {
      p_name: data.name, p_username: data.username, p_password: data.password,
      p_role: data.role, p_assigned_batch_ids: data.assignedBatchIds || [], p_permissions: data.permissions || []
    });
    throwIfError_(error);
    return res;
  },
  updateUser: async function (role, data) {
    requireAdmin_();
    const { data: res, error } = await sb.rpc('rpc_update_user', {
      p_id: data.id, p_name: data.name || null, p_role: data.role || null,
      p_assigned_batch_ids: data.assignedBatchIds || null,
      p_active: data.active != null ? data.active : null, p_new_password: data.newPassword || null,
      p_permissions: data.permissions || null
    });
    throwIfError_(error);
    return res;
  },
  deleteUser: async function (role, id) {
    requireAdmin_();
    const { data, error } = await sb.rpc('rpc_delete_user', { p_id: id });
    throwIfError_(error);
    return data;
  },

  /* ---------------- BATCHES ---------------- */

  listBatches: async function () {
    const { data, error } = await sb.from('batches').select('*').eq('active', true).order('name');
    throwIfError_(error);
    return data.map(rowToBatch_);
  },
  createBatch: async function (role, data) {
    requirePerm_('batches');
    const id = uid_();
    const { error } = await sb.from('batches').insert({ id: id, name: data.name, description: data.description || '' });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateBatch: async function (role, data) {
    requirePerm_('batches');
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.description != null) patch.description = data.description;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('batches').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteBatch: async function (role, id) {
    requirePerm_('batches');
    const { error } = await sb.from('batches').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  closeBatch: async function (role, id) {
    requirePerm_('batches');
    const { error } = await sb.from('batches').update({ closed: true, closed_at: todayStr() }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },
  restoreBatch: async function (role, id) {
    requirePerm_('batches');
    const { error } = await sb.from('batches').update({ closed: false, closed_at: null }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- SUBJECTS ---------------- */

  listSubjects: async function () {
    const data = await fetchAll_(function () { return sb.from('subjects').select('*').eq('active', true).order('name').order('id'); });
    return data.map(rowToSubject_);
  },
  createSubject: async function (role, data) {
    requirePerm_('subjects');
    const id = uid_();
    const { error } = await sb.from('subjects').insert({ id: id, name: data.name, batch_id: data.batchId });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateSubject: async function (role, data) {
    requirePerm_('subjects');
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.batchId != null) patch.batch_id = data.batchId;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('subjects').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteSubject: async function (role, id) {
    requirePerm_('subjects');
    const { error } = await sb.from('subjects').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- STUDENTS ---------------- */

  listStudents: async function () {
    const data = await fetchAll_(function () { return sb.from('students').select('*').eq('active', true).eq('discontinued', false).order('name').order('id'); });
    return data.map(rowToStudent_);
  },
  createStudent: async function (role, data) {
    requirePerm_('student_add');
    const id = uid_();
    const cp = data.contacts ? contactPatch_(data.contacts) : { contacts: normalizeContacts_({ phone: data.phone, parent_phone: data.parentPhone }), phone: data.phone || '', parent_phone: data.parentPhone || '' };
    const { error } = await sb.from('students').insert({
      id: id, name: data.name, roll_no: data.rollNo || '', batch_id: data.batchId,
      phone: cp.phone, email: data.email || '', parent_phone: cp.parent_phone, contacts: cp.contacts,
      admission_date: data.admissionDate || new Date().toISOString().slice(0, 10)
    });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateStudent: async function (role, data) {
    requirePerm_('student_edit');
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.rollNo != null) patch.roll_no = data.rollNo;
    if (data.batchId != null) patch.batch_id = data.batchId;
    if (data.contacts) { const cp = contactPatch_(data.contacts); patch.contacts = cp.contacts; patch.phone = cp.phone; patch.parent_phone = cp.parent_phone; }
    else {
      if (data.phone != null) patch.phone = data.phone;
      if (data.parentPhone != null) patch.parent_phone = data.parentPhone;
    }
    if (data.email != null) patch.email = data.email;
    if (data.admissionDate != null) patch.admission_date = data.admissionDate;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('students').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteStudent: async function (role, id) {
    requirePerm_('student_delete');
    const { error } = await sb.from('students').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },
  listDiscontinuedStudents: async function () {
    const data = await fetchAll_(function () { return sb.from('students').select('*').eq('active', true).eq('discontinued', true).order('name').order('id'); });
    return data.map(rowToStudent_);
  },
  discontinueStudent: async function (role, id, reason) {
    requirePerm_('student_discontinue');
    const { error } = await sb.from('students').update({ discontinued: true, discontinued_at: todayStr(), discontinue_reason: reason || '' }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },
  restoreStudent: async function (role, id) {
    requirePerm_('student_discontinue');
    const { error } = await sb.from('students').update({ discontinued: false, discontinued_at: null, discontinue_reason: '' }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },
  bulkImportStudents: async function (role, batchId, csvText) {
    requirePerm_('bulk_import');
    let rows = parseCsv_(csvText);
    if (rows.length && /^name$/i.test((rows[0][0] || '').trim())) rows = rows.slice(1);

    const today = new Date().toISOString().slice(0, 10);
    const records = rows.map(function (parts) {
      return {
        id: uid_(), name: parts[0] || '', roll_no: parts[1] || '', batch_id: batchId,
        phone: cleanPhone_(parts[2]), email: parts[3] || '', admission_date: today
      };
    }).filter(function (r) { return r.name; });

    if (records.length) await insertChunked_('students', records);
    return { success: true, count: records.length };
  },

  /* ---------------- BOOTSTRAP + SETTINGS ---------------- */

  getBootstrapData: async function () {
    const [allBatches, subjects, students, discontinued, configRes] = await Promise.all([
      API.listBatches(), API.listSubjects(), API.listStudents(), API.listDiscontinuedStudents(),
      sb.from('config').select('*')
    ]);
    throwIfError_(configRes.error);
    const config = {};
    configRes.data.forEach(function (r) { config[r.key] = r.value; });
    return {
      batches: allBatches.filter(function (b) { return !b.Closed; }),
      closedBatches: allBatches.filter(function (b) { return b.Closed; }),
      subjects: subjects, students: students, discontinued: discontinued,
      instituteName: config.InstituteName || 'Unacademy Class Attendance',
      defaulterThreshold: Number(config.DefaulterThreshold || 75)
    };
  },
  updateSettings: async function (role, data) {
    requireAdmin_();
    const upserts = [];
    if (data.instituteName != null) upserts.push({ key: 'InstituteName', value: String(data.instituteName) });
    if (data.defaulterThreshold != null) upserts.push({ key: 'DefaulterThreshold', value: String(data.defaulterThreshold) });
    if (upserts.length) { const { error } = await sb.from('config').upsert(upserts); throwIfError_(error); }
    return { success: true };
  },

  /* ---------------- ATTENDANCE ---------------- */

  submitAttendance: async function (user, date, batchId, subjectId, records) {
    requirePerm_('mark');
    assertBatchAccess_(user, batchId);
    const { data: existing, error: selErr } = await sb.from('attendance').select('*')
      .eq('date', date).eq('batch_id', batchId).eq('subject_id', subjectId);
    throwIfError_(selErr);

    const priorByStudent = {};
    (existing || []).forEach(function (r) { priorByStudent[r.student_id] = { remark: r.remark || '', reason: r.reason || '', color: r.color || '' }; });

    if (existing && existing.length) {
      const { error: delErr } = await sb.from('attendance').delete().eq('date', date).eq('batch_id', batchId).eq('subject_id', subjectId);
      throwIfError_(delErr);
    }

    const rows = records.map(function (rec) {
      const prior = priorByStudent[rec.studentId] || {};
      return {
        id: uid_(), date: date, batch_id: batchId, subject_id: subjectId, student_id: rec.studentId,
        status: rec.status, marked_by: user.name,
        remark: rec.remark != null ? rec.remark : (prior.remark || ''),
        reason: rec.reason != null ? rec.reason : (prior.reason || ''),
        color: rec.color != null ? rec.color : (prior.color || '')
      };
    });
    if (rows.length) { const { error } = await sb.from('attendance').insert(rows); throwIfError_(error); }
    // attendance is now marked for this class, so it can no longer be flagged Holiday / Cancelled / No class
    await sb.from('class_off').delete().eq('date', date).eq('batch_id', batchId).eq('subject_id', subjectId);
    return { success: true, count: rows.length };
  },

  /** Holiday / Class Cancelled / No Class for a batch on a day (one row per subject). Replaces any attendance saved for those classes. */
  setClassOff: async function (user, date, batchId, subjectIds, type, remark) {
    requirePerm_('mark');
    assertBatchAccess_(user, batchId);
    if (['Holiday', 'Class Cancelled', 'No Class'].indexOf(type) === -1) throw new Error('Unknown day type.');
    if (!subjectIds || !subjectIds.length) throw new Error('This batch has no subjects yet.');
    const del = await sb.from('attendance').delete().eq('date', date).eq('batch_id', batchId).in('subject_id', subjectIds);
    throwIfError_(del.error);
    const rows = subjectIds.map(function (sid) {
      return { date: date, batch_id: batchId, subject_id: sid, type: type, remark: remark || '', marked_by: user.name };
    });
    const { error } = await sb.from('class_off').upsert(rows, { onConflict: 'batch_id,subject_id,date' });
    throwIfError_(error);
    return { success: true };
  },
  getClassOff: async function (batchId, date) {
    const { data, error } = await sb.from('class_off').select('subject_id, type, remark').eq('batch_id', batchId).eq('date', date);
    throwIfError_(error);
    return data.map(function (r) { return { SubjectID: r.subject_id, Type: r.type, Remark: r.remark || '' }; });
  },

  getSessionAttendance: async function (batchId, subjectId, date) {
    const { data, error } = await sb.from('attendance').select('*')
      .eq('batch_id', batchId).eq('subject_id', subjectId).eq('date', date);
    throwIfError_(error);
    return data.map(function (r) { return { StudentID: r.student_id, SubjectID: r.subject_id, Status: r.status }; });
  },

  /** Every mark for a whole batch on one day, across all its subjects (e.g. what a bulk upload created). */
  getBatchDayAttendance: async function (batchId, date) {
    const data = await fetchAll_(function () {
      return sb.from('attendance').select('student_id, subject_id, status').eq('batch_id', batchId).eq('date', date).order('id');
    });
    return data.map(function (r) { return { StudentID: r.student_id, SubjectID: r.subject_id, Status: r.status }; });
  },

  getAttendanceRecords: async function (filters) {
    filters = filters || {};
    const data = await fetchAll_(function () { return buildRecordsQuery_(filters, false).order('date', { ascending: false }).order('id'); });
    return data.map(rowToRecord_);
  },

  /** For the Records screen: just the newest `limit` rows plus the true total —
   *  so opening it with no filters doesn't try to pull tens of thousands of rows. */
  getAttendanceRecordsPage: async function (filters, limit) {
    filters = filters || {};
    const { data, error, count } = await buildRecordsQuery_(filters, true)
      .order('date', { ascending: false }).order('id').limit(limit || 500);
    throwIfError_(error);
    return { records: data.map(rowToRecord_), total: count == null ? data.length : count };
  },

  updateAttendanceRecord: async function (role, id, data) {
    const patch = {};
    if (data.remark != null) patch.remark = data.remark;
    if (data.reason != null) patch.reason = data.reason;
    if (data.color != null) patch.color = data.color;
    if (data.status != null) patch.status = data.status;
    const { error } = await sb.from('attendance').update(patch).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- ABSENTEE CALLING ---------------- */

  getAbsenteesForDate: async function (batchId, date) {
    const [res, cnt, offRes] = await Promise.all([
      sb.from('attendance')
        .select('student_id, remark, reason, color, subjects(name), students(name, roll_no, phone, parent_phone, contacts)')
        .eq('batch_id', batchId).eq('date', date).eq('status', 'Absent'),
      sb.from('attendance').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('date', date),
      sb.from('class_off').select('type, remark').eq('batch_id', batchId).eq('date', date)
    ]);
    throwIfError_(res.error);
    throwIfError_(cnt.error);
    const data = res.data;

    const byStudent = {};
    data.forEach(function (r) {
      if (!byStudent[r.student_id]) {
        const s = r.students;
        byStudent[r.student_id] = {
          studentId: r.student_id, name: s ? s.name : '(deleted student)', rollNo: s ? (s.roll_no || '') : '',
          phone: s ? (s.phone || '') : '', parentPhone: s ? (s.parent_phone || '') : '', contacts: s ? normalizeContacts_(s) : [],
          subjects: [], remark: '', reason: '', color: ''
        };
      }
      const entry = byStudent[r.student_id];
      const subjName = r.subjects ? r.subjects.name : '';
      if (subjName && entry.subjects.indexOf(subjName) === -1) entry.subjects.push(subjName);
      if (!entry.remark && r.remark) entry.remark = r.remark;
      if (!entry.reason && r.reason) entry.reason = r.reason;
      if (!entry.color && r.color) entry.color = r.color;
    });
    const absentees = Object.keys(byStudent).map(function (k) { return byStudent[k]; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    const off = [];
    ((offRes && offRes.data) || []).forEach(function (r) { if (!off.some(function (o) { return o.type === r.type && o.remark === (r.remark || ''); })) off.push({ type: r.type, remark: r.remark || '' }); });
    return { absentees: absentees, totalMarked: cnt.count || 0, off: off };
  },

  saveAbsenteeCall: async function (role, studentId, batchId, date, data) {
    requirePerm_('calling');
    const patch = {};
    if (data.remark != null) patch.remark = data.remark;
    if (data.reason != null) patch.reason = data.reason;
    if (data.color != null) patch.color = data.color;
    const { error } = await sb.from('attendance').update(patch)
      .eq('student_id', studentId).eq('batch_id', batchId).eq('date', date);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- REPORTS ---------------- */

  getStudentWiseReport: async function (filters) {
    filters = filters || {};
    // Computed inside the database (one fast query) — pulling every attendance row
    // into the browser to count them doesn't scale past a few thousand rows.
    const { data, error } = await sb.rpc('rpc_student_wise_report', {
      p_batch_id: filters.batchId || null, p_from: filters.from || null, p_to: filters.to || null
    });
    if (!error) return restrictToMyBatches_(data);
    return studentWiseFromRecords_(await API.getAttendanceRecords(filters)); // fallback if schema.sql wasn't re-run yet
  },

  getBatchWiseReport: async function (filters) {
    filters = filters || {};
    const { data, error } = await sb.rpc('rpc_batch_wise_report', {
      p_batch_id: filters.batchId || null, p_from: filters.from || null, p_to: filters.to || null
    });
    if (!error) return restrictToMyBatches_(data);
    return batchWiseFromRecords_(await API.getAttendanceRecords(filters));
  },

  getDefaultersReport: async function (filters) {
    const configRes = await sb.from('config').select('*').eq('key', 'DefaulterThreshold').single();
    const threshold = Number((configRes.data && configRes.data.value) || 75);
    const report = await API.getStudentWiseReport(filters);
    return report.filter(function (s) { return s.percentage < threshold && s.totalSessions > 0 && !s.discontinued; });
  },

  getStudentReportCard: async function (studentId, filters) {
    const f = Object.assign({}, filters || {}, { studentId: studentId });
    const records = await API.getAttendanceRecords(f);
    const { data: studentRow } = await sb.from('students').select('*, batches(name)').eq('id', studentId).single();
    const total = records.length;
    const present = records.filter(function (r) { return r.status === 'Present' || r.status === 'Late'; }).length;
    return {
      student: studentRow ? {
        name: studentRow.name, rollNo: studentRow.roll_no || '', phone: studentRow.phone || '',
        parentPhone: studentRow.parent_phone || '', contacts: normalizeContacts_(studentRow), batchName: studentRow.batches ? studentRow.batches.name : ''
      } : null,
      summary: { total: total, present: present, absent: total - present, percentage: total ? Math.round((present / total) * 1000) / 10 : 0 },
      records: records
    };
  },

  /** One student who moved between batches shows up as several student profiles — this adds their reports together. */
  getCombinedReportCard: async function (ids, filters) {
    const cards = await Promise.all(ids.map(function (id) { return API.getStudentReportCard(id, filters); }));
    const valid = cards.filter(function (c) { return c.student; });
    if (!valid.length) return { student: null, profiles: [], summary: { total: 0, present: 0, absent: 0, percentage: 0 }, records: [] };
    const records = [].concat.apply([], valid.map(function (c) { return c.records; }))
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    const total = records.length;
    const present = records.filter(function (r) { return r.status === 'Present' || r.status === 'Late'; }).length;
    const uniq = function (arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }); };
    const batchOrder = uniq(records.slice().reverse().map(function (r) { return r.batchName; })); // oldest batch first
    const profiles = valid.map(function (c) { return { name: c.student.name, rollNo: c.student.rollNo, batchName: c.student.batchName, contacts: c.student.contacts, summary: c.summary }; });
    return {
      student: {
        name: uniq(valid.map(function (c) { return c.student.name; })).join(' / '),
        rollNo: uniq(valid.map(function (c) { return c.student.rollNo; })).join(' / '),
        batchName: (batchOrder.length ? batchOrder : uniq(valid.map(function (c) { return c.student.batchName; }))).join(' → '),
        contacts: valid[0].student.contacts
      },
      profiles: profiles,
      summary: { total: total, present: present, absent: total - present, percentage: total ? Math.round((present / total) * 1000) / 10 : 0 },
      records: records
    };
  },

  /* ---------------- ACTIVITY LOG (admin) ---------------- */

  listActivity: async function (filters) {
    requireAdmin_();
    const f = filters || {};
    const size = f.pageSize || 50, page = f.page || 0;
    let q = sb.from('activity_log').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (f.userId) q = q.eq('user_id', f.userId);
    if (f.from) q = q.gte('created_at', new Date(f.from + 'T00:00:00').toISOString());
    if (f.to) q = q.lte('created_at', new Date(f.to + 'T23:59:59').toISOString());
    if (f.search) { const t = f.search.replace(/[%,()]/g, ' ').trim(); if (t) q = q.or('action.ilike.%' + t + '%,details.ilike.%' + t + '%'); }
    const { data, error, count } = await q.range(page * size, page * size + size - 1);
    throwIfError_(error);
    return { rows: data, total: count || 0 };
  },

  /* ---------------- BULK ATTENDANCE IMPORT (historical backfill) ---------------- */

  bulkImportAttendance: async function (role, csvText) {
    requirePerm_('bulk_import');
    const progress = function (msg) { if (typeof importProgress === 'function') importProgress(msg); };

    progress('Reading file…');
    let rows = parseCsv_(csvText);
    let rowOffset = 1; // CSV row number of rows[0] (row 1 = first line of the file)
    if (rows.length && /^name$/i.test((rows[0][0] || '').trim())) { rows = rows.slice(1); rowOffset = 2; }

    progress('Checking what already exists…');
    const [batchRows, subjectRows, studentRows] = await Promise.all([
      fetchAll_(function () { return sb.from('batches').select('id, name').order('id'); }),
      fetchAll_(function () { return sb.from('subjects').select('id, name, batch_id').order('id'); }),
      fetchAll_(function () { return sb.from('students').select('id, name, roll_no, batch_id').order('id'); })
    ]);

    const batchByName = {};
    batchRows.forEach(function (b) { batchByName[String(b.name).trim().toLowerCase()] = { ID: b.id }; });
    const subjectByKey = {};
    subjectRows.forEach(function (s) { subjectByKey[s.batch_id + '||' + String(s.name).trim().toLowerCase()] = { ID: s.id }; });
    // A student is matched by roll number within the batch when a roll number is given;
    // only when the roll number is blank do we fall back to matching on name.
    const studentByRoll = {}, studentByName = {};
    studentRows.forEach(function (s) {
      const rec = { ID: s.id, name: s.name, roll: s.roll_no || '', row: null };
      if (s.roll_no) studentByRoll[s.batch_id + '||' + String(s.roll_no).trim().toLowerCase()] = rec;
      studentByName[s.batch_id + '||' + String(s.name).trim().toLowerCase()] = rec;
    });

    const CLASS_SLOTS = ['1st Class', '2nd Class', '3rd Class'];
    const today = new Date().toISOString().slice(0, 10);
    const newBatches = [], newSubjects = [], newStudents = [], newAttendance = [];
    const seenSlots = {};                 // student|subject|date — catches duplicate rows inside the file
    const unknown = {};                   // unrecognised text found in a class column → count
    const invalidDates = { count: 0, samples: [] };
    const nameMismatch = { count: 0, samples: [] };
    let noClassRows = 0, missingFieldRows = 0, duplicateRows = 0;

    rows.forEach(function (cols, idx) {
      const rowNo = idx + rowOffset;
      const name = (cols[0] || '').trim();
      const rollNo = (cols[1] || '').trim();
      const parentPhone = cleanPhone_(cols[2]);
      const studentPhone = cleanPhone_(cols[3]);
      const batchName = (cols[4] || '').trim();
      const slotValues = [cols[6], cols[7], cols[8]];
      const remark = (cols[9] || '').trim();
      const reason = (cols[10] || '').trim();

      if (!name || !batchName) { missingFieldRows++; return; }
      const isoDate = parseDmyDate_(cols[5]);
      if (!isoDate) {
        invalidDates.count++;
        if (invalidDates.samples.length < 5) invalidDates.samples.push({ row: rowNo, value: cols[5] || '(blank)' });
        return;
      }

      const batchKey = batchName.toLowerCase();
      let batch = batchByName[batchKey];
      if (!batch) {
        batch = { ID: uid_() };
        batchByName[batchKey] = batch;
        newBatches.push({ id: batch.ID, name: batchName, description: 'Auto-created during bulk attendance import' });
      }

      const nameKey = batch.ID + '||' + name.toLowerCase();
      const rollKey = rollNo ? batch.ID + '||' + rollNo.toLowerCase() : null;
      let student = rollKey ? studentByRoll[rollKey] : studentByName[nameKey];
      if (!student && rollKey) {
        const sameName = studentByName[nameKey];
        if (sameName && !sameName.roll) student = sameName;   // an existing student that just had no roll number yet
      }
      if (student && rollKey && student.name.trim().toLowerCase() !== name.toLowerCase()) {
        nameMismatch.count++;
        if (nameMismatch.samples.length < 5) nameMismatch.samples.push({ roll: rollNo, kept: student.name, alsoSeen: name });
      }
      if (!student) {
        const dbRow = { id: uid_(), name: name, roll_no: rollNo, batch_id: batch.ID, phone: studentPhone, parent_phone: parentPhone, admission_date: today };
        student = { ID: dbRow.id, name: name, roll: rollNo, row: dbRow };
        if (rollKey) studentByRoll[rollKey] = student;
        studentByName[nameKey] = student;
        newStudents.push(dbRow);
      } else if (student.row) {
        // same new student seen again — fill in a phone number if the first row didn't have one
        if (!student.row.phone && studentPhone) student.row.phone = studentPhone;
        if (!student.row.parent_phone && parentPhone) student.row.parent_phone = parentPhone;
      }

      let gotAny = false;
      CLASS_SLOTS.forEach(function (slotName, i) {
        const raw = String(slotValues[i] || '').trim();
        const status = normalizeStatus_(raw);
        if (!status) {
          if (raw && !isNoClassMarker_(raw)) {
            if (unknown[raw] || Object.keys(unknown).length < 60) unknown[raw] = (unknown[raw] || 0) + 1;
          }
          return;
        }
        gotAny = true;
        const subjKey = batch.ID + '||' + slotName.toLowerCase();
        let subject = subjectByKey[subjKey];
        if (!subject) {
          subject = { ID: uid_() };
          subjectByKey[subjKey] = subject;
          newSubjects.push({ id: subject.ID, name: slotName, batch_id: batch.ID });
        }
        const slotKey = student.ID + '|' + subject.ID + '|' + isoDate;
        if (seenSlots[slotKey]) { duplicateRows++; return; }
        seenSlots[slotKey] = true;
        newAttendance.push({ id: uid_(), date: isoDate, batch_id: batch.ID, subject_id: subject.ID, student_id: student.ID, status: status, marked_by: 'Bulk Import', remark: remark, reason: reason });
      });
      if (!gotAny) noClassRows++;
    });

    if (newBatches.length || newSubjects.length || newStudents.length) {
      progress('Creating ' + newBatches.length + ' batch(es), ' + newSubjects.length + ' class slot(s), ' + newStudents.length + ' student(s)…');
      if (newBatches.length) await insertChunked_('batches', newBatches);
      if (newSubjects.length) await insertChunked_('subjects', newSubjects);
      if (newStudents.length) await insertChunked_('students', newStudents);
    }

    let inserted = 0;
    if (newAttendance.length) {
      const countAttendance = async function () {
        const { count, error } = await sb.from('attendance').select('id', { count: 'exact', head: true });
        throwIfError_(error);
        return count || 0;
      };
      const before = await countAttendance();
      try {
        await insertChunked_('attendance', newAttendance, {
          size: 1000, parallel: 3, ignoreDuplicates: true, onConflict: 'student_id,subject_id,date',
          onProgress: function (n) { progress('Saving attendance… ' + n.toLocaleString() + ' of ' + newAttendance.length.toLocaleString()); }
        });
      } catch (e) {
        if (/ON CONFLICT/i.test(e.message)) {
          throw new Error('The database needs its latest setup first — open Supabase → SQL Editor, run the newest schema.sql, then try the import again (nothing was lost; it is safe to retry).');
        }
        throw e;
      }
      inserted = (await countAttendance()) - before;
    }

    const unrecognized = Object.keys(unknown).map(function (k) { return { value: k, count: unknown[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 15);

    return {
      success: true, totalRows: rows.length,
      attendanceRows: newAttendance.length, inserted: inserted, alreadyThere: newAttendance.length - inserted,
      newBatches: newBatches.length, newSubjects: newSubjects.length, newStudents: newStudents.length,
      noClassRows: noClassRows, duplicateRows: duplicateRows, missingFieldRows: missingFieldRows,
      invalidDates: invalidDates, nameMismatch: nameMismatch, unrecognized: unrecognized
    };
  },

  /* ---------------- EXPORT (CSV / Excel / PDF — all done in-browser now) ---------------- */

  exportTable: async function (format, title, headers, rows) {
    requireAdmin_();
    if (format === 'csv') return exportCsv_(title, headers, rows);
    if (format === 'xlsx') return exportXlsx_(title, headers, rows);
    if (format === 'pdf') return exportPdf_(title, headers, rows);
    return { error: 'Unknown format: ' + format };
  }
};

function sanitizeFilename_(name) {
  return String(name || 'export').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_') || 'export';
}
function exportCsv_(title, headers, rows) {
  const escape = function (v) {
    v = v == null ? '' : String(v);
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  };
  const csv = [headers.map(escape).join(',')].concat(rows.map(function (row) { return row.map(escape).join(','); })).join('\r\n');
  return { success: true, filename: sanitizeFilename_(title) + '.csv', mimeType: 'text/csv', base64: btoa(unescape(encodeURIComponent(csv))) };
}
function exportXlsx_(title, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (title || 'Sheet1').substring(0, 30));
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  return { success: true, filename: sanitizeFilename_(title) + '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: wbout };
}
function exportPdf_(title, headers, rows) {
  const doc = new jspdf.jsPDF({ orientation: headers.length > 6 ? 'landscape' : 'portrait' });
  doc.setFontSize(13);
  doc.text(String(title || 'Export'), 14, 15);
  doc.autoTable({ head: [headers], body: rows, startY: 20, styles: { fontSize: 8 } });
  const base64 = doc.output('datauristring').split(',')[1];
  return { success: true, filename: sanitizeFilename_(title) + '.pdf', mimeType: 'application/pdf', base64: base64 };
}

/** Same call signature the rest of script.js already uses everywhere:
 *  gs('functionName', arg1, arg2, ...) → Promise<result>. */
async function gs(fnName) {
  const args = Array.prototype.slice.call(arguments, 1);
  if (!API[fnName]) throw new Error('Unknown function: ' + fnName);
  return API[fnName].apply(null, args);
}


/* ================= ACTIVITY LOG: who did what =================
   Every change made through the app is written to the activity_log table with the
   login that did it. A failure to write the log never blocks the real action. */

function logActivity_(action, details, userOverride) {
  try {
    const u = userOverride || currentUser_();
    if (!u) return;
    sb.from('activity_log').insert({ user_id: String(u.id || ''), user_name: u.name || u.username || '', role: u.role || '', action: action, details: details || '' })
      .then(function () { }, function () { });
  } catch (e) { /* never block the action */ }
}
const AUDIT_NAMES_ = {
  batch: function (id) { return (typeof batchNameAny === 'function') ? batchNameAny(id) : id; },
  subject: function (id) { const x = (state.subjects || []).find(function (v) { return v.ID === id; }); return x ? x.Name : id; },
  student: function (id) {
    const x = (state.students || []).concat(state.discontinued || []).find(function (v) { return v.ID === id; });
    return x ? x.Name + (x.RollNo ? ' (' + x.RollNo + ')' : '') : id;
  }
};
(function wireAudit_() {
  const N = AUDIT_NAMES_;
  const rows = {
    login: function (a, res) { return (res && !res.error) ? { action: 'Login', details: '', user: res } : null; },
    changeOwnPassword: function (a, res) { return (res && res.error) ? null : { action: 'Password changed', details: 'Own password' }; },
    submitAttendance: function (a) {
      const recs = a[4] || [], c = { Present: 0, Absent: 0, Late: 0 };
      recs.forEach(function (r) { if (c[r.status] != null) c[r.status]++; });
      return { action: 'Attendance saved', details: N.batch(a[2]) + ' · ' + N.subject(a[3]) + ' · ' + a[1] + ' — ' + recs.length + ' students (P ' + c.Present + ', A ' + c.Absent + ', L ' + c.Late + ')' };
    },
    setClassOff: function (a) { return { action: 'Day marked: ' + a[4], details: N.batch(a[2]) + ' · ' + a[1] + (a[5] ? ' — ' + a[5] : '') }; },
    saveAbsenteeCall: function (a) { const d = a[4] || {}; return { action: 'Calling note saved', details: N.student(a[1]) + ' · ' + a[3] + (d.color ? ' · flag ' + d.color : '') + (d.remark ? ' — ' + d.remark : '') }; },
    createBatch: function (a) { return { action: 'Batch added', details: a[1].name }; },
    updateBatch: function (a) { return { action: 'Batch edited', details: N.batch(a[1].id) + (a[1].name ? ' → ' + a[1].name : '') }; },
    closeBatch: function (a) { return { action: 'Batch closed', details: N.batch(a[1]) }; },
    restoreBatch: function (a) { return { action: 'Batch restored', details: N.batch(a[1]) }; },
    deleteBatch: function (a) { return { action: 'Batch deleted', details: N.batch(a[1]) }; },
    createSubject: function (a) { return { action: 'Subject added', details: a[1].name + ' · ' + N.batch(a[1].batchId) }; },
    updateSubject: function (a) { return { action: 'Subject edited', details: N.subject(a[1].id) + (a[1].name ? ' → ' + a[1].name : '') }; },
    deleteSubject: function (a) { return { action: 'Subject deleted', details: N.subject(a[1]) }; },
    createStudent: function (a) { return { action: 'Student added', details: a[1].name + (a[1].rollNo ? ' (' + a[1].rollNo + ')' : '') + ' · ' + N.batch(a[1].batchId) }; },
    updateStudent: function (a) { return { action: 'Student edited', details: N.student(a[1].id) + (a[1].name ? ' → ' + a[1].name : '') }; },
    deleteStudent: function (a) { return { action: 'Student deleted', details: N.student(a[1]) }; },
    discontinueStudent: function (a) { return { action: 'Student discontinued', details: N.student(a[1]) + (a[2] ? ' — ' + a[2] : '') }; },
    restoreStudent: function (a) { return { action: 'Student restored', details: N.student(a[1]) }; },
    bulkImportStudents: function (a, res) { return { action: 'Bulk import: students', details: N.batch(a[1]) + ' — ' + JSON.stringify(res).slice(0, 160) }; },
    bulkImportAttendance: function (a, res) { return { action: 'Bulk import: attendance', details: JSON.stringify(res).slice(0, 200) }; },
    createUser: function (a, res) { return (res && res.error) ? null : { action: 'Login created', details: a[1].username + ' · ' + a[1].role }; },
    updateUser: function (a, res, pre) { return (res && res.error) ? null : { action: 'Login edited', details: (pre || a[1].name || a[1].id) + (a[1].role ? ' · ' + a[1].role : '') + (a[1].newPassword ? ' · password reset' : '') + (a[1].active === false ? ' · disabled' : '') }; },
    deleteUser: function (a, res, pre) { return { action: 'Login deleted', details: pre || a[1] }; },
    updateSettings: function () { return { action: 'Settings changed', details: '' }; },
    exportTable: function (a) { return { action: 'Export ' + String(a[0]).toUpperCase(), details: a[1] }; }
  };
  const needsLookup = { updateUser: 1, deleteUser: 1 };
  Object.keys(rows).forEach(function (name) {
    const orig = API[name];
    if (!orig) return;
    API[name] = async function () {
      const args = Array.prototype.slice.call(arguments);
      let pre = null;
      if (needsLookup[name]) {
        try { const id = name === 'deleteUser' ? args[1] : args[1].id; const list = await API.listUsers(); const u = (list || []).find(function (x) { return x.id === id; }); pre = u ? u.name + ' (' + u.username + ')' : null; } catch (e) { }
      }
      const res = await orig.apply(API, args);
      try { const e = rows[name](args, res, pre); if (e) logActivity_(e.action, e.details, e.user); } catch (e) { }
      return res;
    };
  });
})();
