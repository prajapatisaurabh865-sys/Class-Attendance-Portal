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

function requireAdmin_(role) {
  if (role !== 'Admin') throw new Error('Only an admin can do this.');
}
function assertBatchAccess_(user, batchId) {
  if (user.role === 'Admin') return;
  if ((user.assignedBatchIds || []).indexOf(batchId) === -1) throw new Error('You are not assigned to this batch.');
}
function throwIfError_(error) { if (error) throw new Error(error.message || String(error)); }
function uid_() { return crypto.randomUUID(); }

/** Same tiny CSV-line parser as the old backend — handles "quoted, fields". */
function parseCsvLine_(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}
function parseDmyDate_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
}
function normalizeStatus_(v) {
  v = String(v || '').trim().toLowerCase();
  if (!v) return null;
  if (['present', 'p', '1', 'yes', 'y'].indexOf(v) !== -1) return 'Present';
  if (['absent', 'a', '0', 'no', 'n'].indexOf(v) !== -1) return 'Absent';
  if (['late', 'l'].indexOf(v) !== -1) return 'Late';
  return null;
}

/* -------- row → the same shape script.js already expects -------- */
function rowToBatch_(r) { return { ID: r.id, Name: r.name, Description: r.description || '', Active: r.active }; }
function rowToSubject_(r) { return { ID: r.id, Name: r.name, BatchID: r.batch_id, Active: r.active }; }
function rowToStudent_(r) {
  return {
    ID: r.id, Name: r.name, RollNo: r.roll_no || '', BatchID: r.batch_id,
    Phone: r.phone || '', Email: r.email || '', ParentPhone: r.parent_phone || '',
    AdmissionDate: r.admission_date || '', Active: r.active
  };
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
  listUsers: async function (role) {
    requireAdmin_(role);
    const { data, error } = await sb.rpc('rpc_list_users');
    throwIfError_(error);
    return data;
  },
  createUser: async function (role, data) {
    requireAdmin_(role);
    const { data: res, error } = await sb.rpc('rpc_create_user', {
      p_name: data.name, p_username: data.username, p_password: data.password,
      p_role: data.role, p_assigned_batch_ids: data.assignedBatchIds || []
    });
    throwIfError_(error);
    return res;
  },
  updateUser: async function (role, data) {
    requireAdmin_(role);
    const { data: res, error } = await sb.rpc('rpc_update_user', {
      p_id: data.id, p_name: data.name || null, p_role: data.role || null,
      p_assigned_batch_ids: data.assignedBatchIds || null,
      p_active: data.active != null ? data.active : null, p_new_password: data.newPassword || null
    });
    throwIfError_(error);
    return res;
  },
  deleteUser: async function (role, id) {
    requireAdmin_(role);
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
    requireAdmin_(role);
    const id = uid_();
    const { error } = await sb.from('batches').insert({ id: id, name: data.name, description: data.description || '' });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateBatch: async function (role, data) {
    requireAdmin_(role);
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.description != null) patch.description = data.description;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('batches').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteBatch: async function (role, id) {
    requireAdmin_(role);
    const { error } = await sb.from('batches').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- SUBJECTS ---------------- */

  listSubjects: async function () {
    const { data, error } = await sb.from('subjects').select('*').eq('active', true).order('name');
    throwIfError_(error);
    return data.map(rowToSubject_);
  },
  createSubject: async function (role, data) {
    requireAdmin_(role);
    const id = uid_();
    const { error } = await sb.from('subjects').insert({ id: id, name: data.name, batch_id: data.batchId });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateSubject: async function (role, data) {
    requireAdmin_(role);
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.batchId != null) patch.batch_id = data.batchId;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('subjects').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteSubject: async function (role, id) {
    requireAdmin_(role);
    const { error } = await sb.from('subjects').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },

  /* ---------------- STUDENTS ---------------- */

  listStudents: async function () {
    const { data, error } = await sb.from('students').select('*').eq('active', true).order('name');
    throwIfError_(error);
    return data.map(rowToStudent_);
  },
  createStudent: async function (role, data) {
    requireAdmin_(role);
    const id = uid_();
    const { error } = await sb.from('students').insert({
      id: id, name: data.name, roll_no: data.rollNo || '', batch_id: data.batchId,
      phone: data.phone || '', email: data.email || '', parent_phone: data.parentPhone || '',
      admission_date: data.admissionDate || new Date().toISOString().slice(0, 10)
    });
    throwIfError_(error);
    return { success: true, id: id };
  },
  updateStudent: async function (role, data) {
    requireAdmin_(role);
    const patch = {};
    if (data.name != null) patch.name = data.name;
    if (data.rollNo != null) patch.roll_no = data.rollNo;
    if (data.batchId != null) patch.batch_id = data.batchId;
    if (data.phone != null) patch.phone = data.phone;
    if (data.email != null) patch.email = data.email;
    if (data.parentPhone != null) patch.parent_phone = data.parentPhone;
    if (data.admissionDate != null) patch.admission_date = data.admissionDate;
    if (data.active != null) patch.active = data.active;
    const { error } = await sb.from('students').update(patch).eq('id', data.id);
    throwIfError_(error);
    return { success: true };
  },
  deleteStudent: async function (role, id) {
    requireAdmin_(role);
    const { error } = await sb.from('students').update({ active: false }).eq('id', id);
    throwIfError_(error);
    return { success: true };
  },
  bulkImportStudents: async function (role, batchId, csvText) {
    requireAdmin_(role);
    let lines = csvText.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(String);
    if (lines.length && /^name\b/i.test((lines[0].split(',')[0] || '').replace(/^"|"$/g, '').trim())) lines = lines.slice(1);

    const rows = lines.map(function (line) {
      const parts = parseCsvLine_(line);
      return {
        id: uid_(), name: parts[0] || '', roll_no: parts[1] || '', batch_id: batchId,
        phone: parts[2] || '', email: parts[3] || '',
        admission_date: new Date().toISOString().slice(0, 10)
      };
    }).filter(function (r) { return r.name; });

    if (rows.length) { const { error } = await sb.from('students').insert(rows); throwIfError_(error); }
    return { success: true, count: rows.length };
  },

  /* ---------------- BOOTSTRAP + SETTINGS ---------------- */

  getBootstrapData: async function () {
    const [batches, subjects, students, configRes] = await Promise.all([
      API.listBatches(), API.listSubjects(), API.listStudents(),
      sb.from('config').select('*')
    ]);
    throwIfError_(configRes.error);
    const config = {};
    configRes.data.forEach(function (r) { config[r.key] = r.value; });
    return {
      batches: batches, subjects: subjects, students: students,
      instituteName: config.InstituteName || 'Attendance Manager',
      defaulterThreshold: Number(config.DefaulterThreshold || 75)
    };
  },
  updateSettings: async function (role, data) {
    requireAdmin_(role);
    const upserts = [];
    if (data.instituteName != null) upserts.push({ key: 'InstituteName', value: String(data.instituteName) });
    if (data.defaulterThreshold != null) upserts.push({ key: 'DefaulterThreshold', value: String(data.defaulterThreshold) });
    if (upserts.length) { const { error } = await sb.from('config').upsert(upserts); throwIfError_(error); }
    return { success: true };
  },

  /* ---------------- ATTENDANCE ---------------- */

  submitAttendance: async function (user, date, batchId, subjectId, records) {
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
    return { success: true, count: rows.length };
  },

  getSessionAttendance: async function (batchId, subjectId, date) {
    const { data, error } = await sb.from('attendance').select('*')
      .eq('batch_id', batchId).eq('subject_id', subjectId).eq('date', date);
    throwIfError_(error);
    return data.map(function (r) { return { StudentID: r.student_id, Status: r.status }; });
  },

  getAttendanceRecords: async function (filters) {
    filters = filters || {};
    let q = sb.from('attendance').select('id, date, status, marked_by, remark, reason, color, batches(name), subjects(name), students(name, roll_no, phone, parent_phone)');
    if (filters.batchId) q = q.eq('batch_id', filters.batchId);
    if (filters.subjectId) q = q.eq('subject_id', filters.subjectId);
    if (filters.studentId) q = q.eq('student_id', filters.studentId);
    if (filters.from) q = q.gte('date', filters.from);
    if (filters.to) q = q.lte('date', filters.to);
    const { data, error } = await q.order('date', { ascending: false });
    throwIfError_(error);
    return data.map(function (r) {
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
    });
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
    const { data, error } = await sb.from('attendance')
      .select('student_id, remark, reason, color, subjects(name), students(name, roll_no, phone, parent_phone)')
      .eq('batch_id', batchId).eq('date', date).eq('status', 'Absent');
    throwIfError_(error);

    const byStudent = {};
    data.forEach(function (r) {
      if (!byStudent[r.student_id]) {
        const s = r.students;
        byStudent[r.student_id] = {
          studentId: r.student_id, name: s ? s.name : '(deleted student)', rollNo: s ? (s.roll_no || '') : '',
          phone: s ? (s.phone || '') : '', parentPhone: s ? (s.parent_phone || '') : '',
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
    return Object.keys(byStudent).map(function (k) { return byStudent[k]; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  },

  saveAbsenteeCall: async function (role, studentId, batchId, date, data) {
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
    const records = await API.getAttendanceRecords(filters || {});
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
  },

  getBatchWiseReport: async function (filters) {
    const records = await API.getAttendanceRecords(filters || {});
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
  },

  getDefaultersReport: async function (filters) {
    const configRes = await sb.from('config').select('*').eq('key', 'DefaulterThreshold').single();
    const threshold = Number((configRes.data && configRes.data.value) || 75);
    const report = await API.getStudentWiseReport(filters);
    return report.filter(function (s) { return s.percentage < threshold && s.totalSessions > 0; });
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
        parentPhone: studentRow.parent_phone || '', batchName: studentRow.batches ? studentRow.batches.name : ''
      } : null,
      summary: { total: total, present: present, absent: total - present, percentage: total ? Math.round((present / total) * 1000) / 10 : 0 },
      records: records
    };
  },

  /* ---------------- BULK ATTENDANCE IMPORT (historical backfill) ---------------- */

  bulkImportAttendance: async function (role, csvText) {
    requireAdmin_(role);
    let lines = String(csvText || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length && /^name\b/i.test(parseCsvLine_(lines[0])[0] || '')) lines = lines.slice(1);

    const [{ data: batchRows }, { data: subjectRows }, { data: studentRows }] = await Promise.all([
      sb.from('batches').select('id, name'), sb.from('subjects').select('id, name, batch_id'), sb.from('students').select('id, name, roll_no, batch_id')
    ]);

    const batchByName = {};
    (batchRows || []).forEach(function (b) { batchByName[String(b.name).trim().toLowerCase()] = { ID: b.id, Name: b.name }; });
    const subjectByKey = {};
    (subjectRows || []).forEach(function (s) { subjectByKey[s.batch_id + '||' + String(s.name).trim().toLowerCase()] = { ID: s.id }; });
    const studentByRollKey = {}, studentByNameKey = {};
    (studentRows || []).forEach(function (s) {
      if (s.roll_no) studentByRollKey[s.batch_id + '||' + String(s.roll_no).trim().toLowerCase()] = { ID: s.id };
      studentByNameKey[s.batch_id + '||' + String(s.name).trim().toLowerCase()] = { ID: s.id };
    });

    const CLASS_SLOTS = ['1st Class', '2nd Class', '3rd Class'];
    const newBatches = [], newSubjects = [], newStudents = [], newAttendance = [];
    let attendanceRows = 0, skippedRows = 0;

    lines.forEach(function (line) {
      const cols = parseCsvLine_(line);
      const name = (cols[0] || '').trim();
      const rollNo = (cols[1] || '').trim();
      const parentPhone = (cols[2] || '').trim();
      const studentPhone = (cols[3] || '').trim();
      const batchName = (cols[4] || '').trim();
      const isoDate = parseDmyDate_(cols[5]);
      const slotStatuses = [cols[6], cols[7], cols[8]];
      const remark = (cols[9] || '').trim();
      const reason = (cols[10] || '').trim();

      if (!name || !batchName || !isoDate) { skippedRows++; return; }

      const batchKey = batchName.toLowerCase();
      let batch = batchByName[batchKey];
      if (!batch) {
        batch = { ID: uid_(), Name: batchName };
        batchByName[batchKey] = batch;
        newBatches.push({ id: batch.ID, name: batchName, description: 'Auto-created during bulk attendance import' });
      }

      const nameKey = batch.ID + '||' + name.toLowerCase();
      const rollKey = rollNo ? batch.ID + '||' + rollNo.toLowerCase() : null;
      let student = (rollKey && studentByRollKey[rollKey]) || studentByNameKey[nameKey];
      if (!student) {
        student = { ID: uid_() };
        if (rollKey) studentByRollKey[rollKey] = student;
        studentByNameKey[nameKey] = student;
        newStudents.push({ id: student.ID, name: name, roll_no: rollNo, batch_id: batch.ID, phone: studentPhone, parent_phone: parentPhone, admission_date: new Date().toISOString().slice(0, 10) });
      }

      let matchedAny = false;
      CLASS_SLOTS.forEach(function (slotName, i) {
        const status = normalizeStatus_(slotStatuses[i]);
        if (!status) return;
        matchedAny = true;
        const subjKey = batch.ID + '||' + slotName.toLowerCase();
        let subject = subjectByKey[subjKey];
        if (!subject) {
          subject = { ID: uid_() };
          subjectByKey[subjKey] = subject;
          newSubjects.push({ id: subject.ID, name: slotName, batch_id: batch.ID });
        }
        newAttendance.push({ id: uid_(), date: isoDate, batch_id: batch.ID, subject_id: subject.ID, student_id: student.ID, status: status, marked_by: 'Bulk Import', remark: remark, reason: reason });
        attendanceRows++;
      });
      if (!matchedAny) skippedRows++;
    });

    if (newBatches.length) { const { error } = await sb.from('batches').insert(newBatches); throwIfError_(error); }
    if (newSubjects.length) { const { error } = await sb.from('subjects').insert(newSubjects); throwIfError_(error); }
    if (newStudents.length) { const { error } = await sb.from('students').insert(newStudents); throwIfError_(error); }
    if (newAttendance.length) { const { error } = await sb.from('attendance').insert(newAttendance); throwIfError_(error); }

    return {
      success: true, attendanceRows: attendanceRows, newBatches: newBatches.length,
      newSubjects: newSubjects.length, newStudents: newStudents.length, skippedRows: skippedRows
    };
  },

  /* ---------------- EXPORT (CSV / Excel / PDF — all done in-browser now) ---------------- */

  exportTable: async function (format, title, headers, rows) {
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
