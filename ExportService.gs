/**
 * ==============================================================
 *  EXPORTSERVICE.GS
 * ==============================================================
 * Takes whatever table is currently on screen (headers + rows, both
 * already built client-side) and returns a base64 file the browser
 * can download — no separate "download server" needed.
 *
 * CSV is built directly (fast, no extra API calls).
 * XLSX/PDF go through a short-lived temp Google Sheet, since Sheets'
 * built-in export endpoints already produce well-formatted files.
 */

function exportTable(format, title, headers, rows) {
  if (format === 'csv') return exportCsv_(title, headers, rows);
  if (format === 'xlsx') return exportViaTempSheet_(title, headers, rows, 'xlsx');
  if (format === 'pdf') return exportViaTempSheet_(title, headers, rows, 'pdf');
  return { error: 'Unknown format: ' + format };
}

function exportCsv_(title, headers, rows) {
  const escape = function (v) {
    v = v == null ? '' : String(v);
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  };
  const lines = [headers.map(escape).join(',')].concat(
    rows.map(function (row) { return row.map(escape).join(','); })
  );
  const csv = lines.join('\r\n');
  return {
    success: true,
    filename: sanitizeFilename_(title) + '.csv',
    mimeType: 'text/csv',
    base64: Utilities.base64Encode(csv, Utilities.Charset.UTF_8)
  };
}

function exportViaTempSheet_(title, headers, rows, format) {
  const tempSS = SpreadsheetApp.create('__export_tmp_' + Utilities.getUuid());
  try {
    const sh = tempSS.getSheets()[0];
    sh.setName(title.substring(0, 90) || 'Sheet1');
    if (headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
    if (rows.length) {
      sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    sh.autoResizeColumns(1, Math.max(headers.length, 1));
    SpreadsheetApp.flush();

    const url = 'https://docs.google.com/spreadsheets/d/' + tempSS.getId() +
      '/export?format=' + format + '&gid=' + sh.getSheetId();
    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const blob = response.getBlob();
    return {
      success: true,
      filename: sanitizeFilename_(title) + '.' + format,
      mimeType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: Utilities.base64Encode(blob.getBytes())
    };
  } finally {
    // Clean up — don't leave export junk in the user's Drive.
    DriveApp.getFileById(tempSS.getId()).setTrashed(true);
  }
}

function sanitizeFilename_(name) {
  return String(name || 'export').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_') || 'export';
}
