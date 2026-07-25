/**
 * ==============================================================
 *  ATTENDANCESERVICE.GS
 * ==============================================================
 * Attendance is per (date, batch, subject) — a "session". A teacher
 * can only submit for a batch they're assigned to (enforced here,
 * not just hidden in the UI).
 */

function assertBatchAccess_(role, assignedBatchIds, batchId) {
  if (role === 'Admin') return;
  if ((assignedBatchIds || []).indexOf(batchId) === -1) {
    throw new Error('You are not assigned to this batch.');
  }
}

/**
 * records: [{ studentId, status }]  status: 'Present' | 'Absent' | 'Late'
 * Overwrites any existing marks for the same date+batch+subject+student
 * so re-submitting a session edits it instead of duplicating rows.
 */
function submitAttendance(user, date, batchId, subjectId, records) {
  assertBatchAccess_(user.role, user.assignedBatchIds, batchId);
  const sh = getSheet(SHEET_NAMES.ATTENDANCE);
  const existing = sheetToObjects_(sh);
  const now = new Date();

  // Remove old rows for this exact session so we can re-write them cleanly.
  const rowsToDelete = [];
  for (let i = 0; i < existing.length; i++) {
    const r = existing[i];
    if (r.Date === date && r.BatchID === batchId && r.SubjectID === subjectId) {
      rowsToDelete.push(findRowIndexById_(sh, r.ID));
    }
  }
  rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (rowIndex) { sh.deleteRow(rowIndex); });

  const newRows = records.map(function (rec) {
    return [Utilities.getUuid(), date, batchId, subjectId, rec.studentId, rec.status, user.name, now];
  });
  if (newRows.length) sh.getRange(sh.getLastRow() + 1, 1, newRows.length, HEADERS.Attendance.length).setValues(newRows);

  return { success: true, count: newRows.length };
}

/** Fetch existing marks for a session, so the UI can pre-fill a re-opened session. */
function getSessionAttendance(batchId, subjectId, date) {
  const rows = sheetToObjects_(getSheet(SHEET_NAMES.ATTENDANCE));
  return rows.filter(function (r) {
    return r.BatchID === batchId && r.SubjectID === subjectId && r.Date === date;
  });
}

/**
 * filters: { batchId, subjectId, studentId, from, to } — any may be omitted.
 * Returns raw attendance rows joined with student/batch/subject names for display.
 */
function getAttendanceRecords(filters) {
  filters = filters || {};
  const rows = sheetToObjects_(getSheet(SHEET_NAMES.ATTENDANCE));
  const batches = keyBy_(listBatches(), 'ID');
  const subjects = keyBy_(listSubjects(), 'ID');
  const students = keyBy_(listStudents(), 'ID');

  return rows
    .filter(function (r) {
      if (filters.batchId && r.BatchID !== filters.batchId) return false;
      if (filters.subjectId && r.SubjectID !== filters.subjectId) return false;
      if (filters.studentId && r.StudentID !== filters.studentId) return false;
      if (filters.from && r.Date < filters.from) return false;
      if (filters.to && r.Date > filters.to) return false;
      return true;
    })
    .map(function (r) {
      return {
        id: r.ID,
        date: r.Date,
        batchName: batches[r.BatchID] ? batches[r.BatchID].Name : '(deleted batch)',
        subjectName: subjects[r.SubjectID] ? subjects[r.SubjectID].Name : '(deleted subject)',
        studentName: students[r.StudentID] ? students[r.StudentID].Name : '(deleted student)',
        rollNo: students[r.StudentID] ? students[r.StudentID].RollNo : '',
        status: r.Status,
        markedBy: r.MarkedBy
      };
    })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

function keyBy_(list, field) {
  const map = {};
  list.forEach(function (item) { map[item[field]] = item; });
  return map;
}
