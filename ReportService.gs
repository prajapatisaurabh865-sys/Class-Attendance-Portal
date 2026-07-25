/**
 * ==============================================================
 *  REPORTSERVICE.GS
 * ==============================================================
 */

/** Per-student attendance % within optional date range/batch/subject filters. */
function getStudentWiseReport(filters) {
  filters = filters || {};
  const records = getAttendanceRecords(filters);
  const students = listStudents();
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
      studentName: s.studentName,
      rollNo: s.rollNo,
      totalSessions: s.total,
      present: s.present,
      absent: s.total - s.present,
      percentage: s.total ? Math.round((s.present / s.total) * 1000) / 10 : 0
    };
  }).sort(function (a, b) { return a.percentage - b.percentage; });
}

/** Per-batch, per-date summary — how many present/absent each session. */
function getBatchWiseReport(filters) {
  filters = filters || {};
  const records = getAttendanceRecords(filters);
  const byKey = {};

  records.forEach(function (r) {
    const key = r.date + '||' + r.batchName + '||' + r.subjectName;
    if (!byKey[key]) byKey[key] = { date: r.date, batchName: r.batchName, subjectName: r.subjectName, present: 0, absent: 0, late: 0, total: 0 };
    byKey[key].total++;
    if (r.status === 'Present') byKey[key].present++;
    else if (r.status === 'Absent') byKey[key].absent++;
    else if (r.status === 'Late') byKey[key].late++;
  });

  return Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

/** Students below the configured attendance threshold. */
function getDefaultersReport(filters) {
  const threshold = Number(getConfig_('DefaulterThreshold', 75));
  return getStudentWiseReport(filters).filter(function (s) { return s.percentage < threshold && s.totalSessions > 0; });
}
