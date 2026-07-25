# Attendance Manager — GitHub Pages + Google Sheets

The website (HTML/CSS/JS) now runs on **GitHub Pages** — fast, static
hosting. Google Sheets stays as the **database**, reached through a small
Google Apps Script API. This fixes the slowness of having Apps Script
serve the whole page on every load.

```
frontend-github-pages/   →  push this to a GitHub repo, enable Pages
backend-apps-script/     →  paste this into script.google.com, deploy as Web App
```

## Part 1 — Backend (Google Apps Script API)

1. Go to [sheets.google.com](https://sheets.google.com), create a new spreadsheet
   (e.g. "Attendance Manager — Database").
2. **Extensions → Apps Script**.
3. Delete the default `Code.gs` content. Add every file from `backend-apps-script/`
   (same names, without the folder): `Code.gs`, `Auth.gs`, `DataService.gs`,
   `AttendanceService.gs`, `ReportService.gs`, `ExportService.gs`.
4. For `appsscript.json`: gear icon (Project Settings) → check "Show appsscript.json
   manifest file in editor" → open it → paste in the one from this folder.
5. Run the **setup** function once (select it in the function dropdown → Run).
   Authorize when asked. Check **View → Logs** (or Executions) to confirm
   "Setup complete" — this created the sheet tabs + a default admin login
   (`admin` / `admin123`).
6. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the deployment URL (ends in `/exec`). You'll need it in Part 2.

Whenever you edit the backend later, redeploy via **Deploy → Manage deployments
→ pencil icon → Version: New version → Deploy** so the same URL picks up the change.

## Part 2 — Frontend (GitHub Pages)

1. Open `frontend-github-pages/script.js` and replace:
   ```js
   const SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
   ```
   with the `/exec` URL you copied in Part 1, e.g.:
   ```js
   const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
   ```
2. Create a new GitHub repository (e.g. `attendance-manager`).
3. Upload the 3 files from `frontend-github-pages/` — `index.html`,
   `styles.css`, `script.js` — to the repo root (via the GitHub web UI's
   "Add file → Upload files", or `git push` if you're comfortable with git).
4. In the repo: **Settings → Pages** → under "Build and deployment", set
   Source: **Deploy from a branch**, Branch: **main**, folder: **/ (root)** → Save.
5. GitHub gives you a URL like `https://yourusername.github.io/attendance-manager/`.
   That's your fast, permanent website link — share this with teachers.

## Login
Same as before: `admin` / `admin123` — change it immediately from
"Change password" after your first login.

## Why this is faster
Previously, Apps Script had to build and send the *entire page* (HTML, CSS, JS)
on every visit, plus every data read/write went through the same script
execution. Now GitHub Pages serves the page itself instantly from a CDN —
Apps Script is only hit for actual data operations (login, save attendance,
load reports), which is exactly what it should be used for.

## Note on speed of Sheets itself
The website will now load instantly. Individual **data actions** (saving
attendance, pulling reports) still go through Apps Script + Sheets, so they
won't be database-fast — but they were never the slow part; the full-page
reload was. If your institute later has hundreds of students and this still
feels slow for data actions specifically, migrating from Sheets to a real
database (Firestore, Postgres, etc.) is the next step up — happy to help
with that later if it comes to it.

## CORS note
`script.js` sends requests with `Content-Type: text/plain` on purpose —
this avoids the browser's CORS "preflight" check, which Apps Script's
Web App doesn't handle. Don't change this content type or cross-origin
calls from GitHub Pages will start failing.
