/**
 * ==============================================================
 *  ATTENDANCE MANAGER — CODE.GS  (API-only backend)
 * ==============================================================
 * The website itself now lives on GitHub Pages (see the
 * frontend-github-pages folder). This Apps Script project is ONLY
 * a JSON API + database (via the Sheet) — it doesn't serve any HTML.
 *
 * FIRST TIME SETUP:
 * 1. Open script.google.com, create a new project, paste in all
 *    the .gs files from this "backend-apps-script" folder.
 * 2. Run the "setup" function once (Run > setup) and grant permissions.
 *    This creates all the required sheet tabs + a default admin login.
 * 3. Deploy > New deployment > Web app.
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 4. Copy the deployment URL (ends in /exec). Paste it into
 *    SCRIPT_URL at the top of script.js in the frontend folder.
 */

const SHEET_NAMES = {
  USERS: 'Users',
  BATCHES: 'Batches',
  SUBJECTS: 'Subjects',
  STUDENTS: 'Students',
  ATTENDANCE: 'Attendance',
  CONFIG: 'Config'
};

const HEADERS = {
  Users: ['ID', 'Name', 'Username', 'PasswordHash', 'Role', 'AssignedBatchIDs', 'Active', 'CreatedAt'],
  Batches: ['ID', 'Name', 'Description', 'Active', 'CreatedAt'],
  Subjects: ['ID', 'Name', 'BatchID', 'Active'],
  Students: ['ID', 'Name', 'RollNo', 'BatchID', 'Phone', 'Email', 'AdmissionDate', 'Active'],
  Attendance: ['ID', 'Date', 'BatchID', 'SubjectID', 'StudentID', 'Status', 'MarkedBy', 'Timestamp'],
  Config: ['Key', 'Value']
};

/**
 * Every function the frontend is allowed to call over the API.
 * Anything not listed here is invisible to doPost, even if it
 * exists as a global function — this is the real security boundary
 * now that the API is reachable from any origin (GitHub Pages, etc).
 */
const API_WHITELIST = [
  'login', 'changeOwnPassword',
  'listUsers', 'createUser', 'updateUser', 'deleteUser',
  'listBatches', 'createBatch', 'updateBatch', 'deleteBatch',
  'listSubjects', 'createSubject', 'updateSubject', 'deleteSubject',
  'listStudents', 'createStudent', 'updateStudent', 'deleteStudent', 'bulkImportStudents',
  'getBootstrapData', 'updateSettings',
  'submitAttendance', 'getSessionAttendance', 'getAttendanceRecords',
  'getStudentWiseReport', 'getBatchWiseReport', 'getDefaultersReport',
  'exportTable'
];

/** A GET just confirms the API is alive — useful for a quick sanity check in the browser. */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Attendance Manager API is running.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** The real endpoint. Frontend POSTs { fn, args } as JSON (sent as text/plain to dodge CORS preflight). */
function doPost(e) {
  let fn = '(unknown)';
  try {
    const req = JSON.parse(e.postData.contents);
    fn = req.fn;
    const args = req.args || [];
    if (API_WHITELIST.indexOf(fn) === -1) throw new Error('Function not allowed: ' + fn);
    const result = this[fn].apply(null, args);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** Harmless no-op — kept only in case a browser ever does send a preflight OPTIONS request. */
function doOptions(e) {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.JSON);
}

function getSS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  const ss = getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Run this once manually from the Apps Script editor. */
function setup() {
  Object.keys(HEADERS).forEach(function (name) {
    const sh = getSheet(name);
    const firstRow = sh.getRange(1, 1, 1, HEADERS[name].length).getValues()[0];
    if (firstRow.join('') === '') {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  });

  const usersSheet = getSheet(SHEET_NAMES.USERS);
  if (usersSheet.getLastRow() < 2) {
    usersSheet.appendRow([
      Utilities.getUuid(),
      'Administrator',
      'admin',
      hashPassword_('admin123'),
      'Admin',
      '',
      true,
      new Date()
    ]);
  }

  const configSheet = getSheet(SHEET_NAMES.CONFIG);
  if (configSheet.getLastRow() < 2) {
    configSheet.appendRow(['DefaulterThreshold', 75]);
    configSheet.appendRow(['InstituteName', 'My Coaching Institute']);
  }

  Logger.log('Setup complete. Default login -> username: admin, password: admin123. Change it from Settings after first login.');
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return digest.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** Converts a sheet's header row + row objects into a plain array-of-objects.
 *  Date cells are converted to ISO strings — google.script.run/JSON can't carry
 *  raw Date objects safely, so we never let one leave this function. */
function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  return rows
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) {
        let v = row[i];
        if (v instanceof Date) v = v.toISOString();
        obj[h] = v;
      });
      return obj;
    })
    .filter(function (obj) { return obj.ID !== '' && obj.ID != null; });
}

function findRowIndexById_(sheet, id) {
  const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function getConfig_(key, fallback) {
  const values = getSheet(SHEET_NAMES.CONFIG).getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) return values[i][1];
  }
  return fallback;
}

function setConfig_(key, value) {
  const sh = getSheet(SHEET_NAMES.CONFIG);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}
