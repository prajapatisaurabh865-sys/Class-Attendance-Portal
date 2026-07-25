/**
 * ==============================================================
 *  DATASERVICE.GS — Batches, Subjects, Students CRUD
 * ==============================================================
 * Every write function takes the acting user's role/assigned batches
 * as the first argument(s) so we can enforce teacher restrictions
 * server-side (never trust the client alone).
 */

/* ---------------- BATCHES ---------------- */

function listBatches() {
  return sheetToObjects_(getSheet(SHEET_NAMES.BATCHES)).filter(function (b) { return b.Active !== false; });
}

function createBatch(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.BATCHES);
  const id = Utilities.getUuid();
  sh.appendRow([id, data.name, data.description || '', true, new Date()]);
  return { success: true, id: id };
}

function updateBatch(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.BATCHES);
  const rowIndex = findRowIndexById_(sh, data.id);
  if (rowIndex === -1) return { error: 'Batch not found.' };
  const headers = HEADERS.Batches;
  if (data.name != null) sh.getRange(rowIndex, headers.indexOf('Name') + 1).setValue(data.name);
  if (data.description != null) sh.getRange(rowIndex, headers.indexOf('Description') + 1).setValue(data.description);
  if (data.active != null) sh.getRange(rowIndex, headers.indexOf('Active') + 1).setValue(data.active);
  return { success: true };
}

function deleteBatch(currentUserRole, id) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.BATCHES);
  const rowIndex = findRowIndexById_(sh, id);
  if (rowIndex === -1) return { error: 'Batch not found.' };
  sh.getRange(rowIndex, HEADERS.Batches.indexOf('Active') + 1).setValue(false); // soft delete
  return { success: true };
}

/* ---------------- SUBJECTS ---------------- */

function listSubjects() {
  return sheetToObjects_(getSheet(SHEET_NAMES.SUBJECTS)).filter(function (s) { return s.Active !== false; });
}

function createSubject(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.SUBJECTS);
  const id = Utilities.getUuid();
  sh.appendRow([id, data.name, data.batchId, true]);
  return { success: true, id: id };
}

function updateSubject(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.SUBJECTS);
  const rowIndex = findRowIndexById_(sh, data.id);
  if (rowIndex === -1) return { error: 'Subject not found.' };
  const headers = HEADERS.Subjects;
  if (data.name != null) sh.getRange(rowIndex, headers.indexOf('Name') + 1).setValue(data.name);
  if (data.batchId != null) sh.getRange(rowIndex, headers.indexOf('BatchID') + 1).setValue(data.batchId);
  if (data.active != null) sh.getRange(rowIndex, headers.indexOf('Active') + 1).setValue(data.active);
  return { success: true };
}

function deleteSubject(currentUserRole, id) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.SUBJECTS);
  const rowIndex = findRowIndexById_(sh, id);
  if (rowIndex === -1) return { error: 'Subject not found.' };
  sh.getRange(rowIndex, HEADERS.Subjects.indexOf('Active') + 1).setValue(false);
  return { success: true };
}

/* ---------------- STUDENTS ---------------- */

function listStudents() {
  return sheetToObjects_(getSheet(SHEET_NAMES.STUDENTS)).filter(function (s) { return s.Active !== false; });
}

function createStudent(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.STUDENTS);
  const id = Utilities.getUuid();
  sh.appendRow([
    id, data.name, data.rollNo || '', data.batchId,
    data.phone || '', data.email || '',
    data.admissionDate || Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'),
    true
  ]);
  return { success: true, id: id };
}

function updateStudent(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.STUDENTS);
  const rowIndex = findRowIndexById_(sh, data.id);
  if (rowIndex === -1) return { error: 'Student not found.' };
  const headers = HEADERS.Students;
  ['name', 'rollNo', 'batchId', 'phone', 'email', 'admissionDate'].forEach(function (field) {
    const colMap = { name: 'Name', rollNo: 'RollNo', batchId: 'BatchID', phone: 'Phone', email: 'Email', admissionDate: 'AdmissionDate' };
    if (data[field] != null) sh.getRange(rowIndex, headers.indexOf(colMap[field]) + 1).setValue(data[field]);
  });
  if (data.active != null) sh.getRange(rowIndex, headers.indexOf('Active') + 1).setValue(data.active);
  return { success: true };
}

function deleteStudent(currentUserRole, id) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.STUDENTS);
  const rowIndex = findRowIndexById_(sh, id);
  if (rowIndex === -1) return { error: 'Student not found.' };
  sh.getRange(rowIndex, HEADERS.Students.indexOf('Active') + 1).setValue(false);
  return { success: true };
}

/** Bulk import students from pasted CSV text: "Name,RollNo,Phone,Email" per line. */
function bulkImportStudents(currentUserRole, batchId, csvText) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.STUDENTS);
  const lines = csvText.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(String);
  const rows = lines.map(function (line) {
    const parts = line.split(',').map(function (p) { return p.trim(); });
    return [
      Utilities.getUuid(), parts[0] || '', parts[1] || '', batchId,
      parts[2] || '', parts[3] || '',
      Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'), true
    ];
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.Students.length).setValues(rows);
  return { success: true, count: rows.length };
}

/** All initial data the app needs right after login, in one round trip. */
function getBootstrapData() {
  return {
    batches: listBatches(),
    subjects: listSubjects(),
    students: listStudents(),
    instituteName: getConfig_('InstituteName', 'Attendance Manager'),
    defaulterThreshold: Number(getConfig_('DefaulterThreshold', 75))
  };
}

function updateSettings(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  if (data.instituteName != null) setConfig_('InstituteName', data.instituteName);
  if (data.defaulterThreshold != null) setConfig_('DefaulterThreshold', data.defaulterThreshold);
  return { success: true };
}
