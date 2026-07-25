/**
 * ==============================================================
 *  AUTH.GS — login + user (admin/teacher) management
 * ==============================================================
 * There's no Google-account login here on purpose — teachers log in
 * with a username/password you create for them, stored (hashed) in
 * the Users sheet. This keeps it usable for staff who don't share
 * your Google account.
 */

/** Called from the login screen. Returns a safe user object (no password) or {error}. */
function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  const users = sheetToObjects_(getSheet(SHEET_NAMES.USERS));
  const user = users.find(function (u) {
    return String(u.Username).trim().toLowerCase() === username && u.Active !== false;
  });
  if (!user) return { error: 'No active account with that username.' };
  if (user.PasswordHash !== hashPassword_(password)) return { error: 'Incorrect password.' };

  return {
    id: user.ID,
    name: user.Name,
    username: user.Username,
    role: user.Role,
    assignedBatchIds: (user.AssignedBatchIDs || '').split(',').map(function (s) { return s.trim(); }).filter(String)
  };
}

function changeOwnPassword(userId, oldPassword, newPassword) {
  const sh = getSheet(SHEET_NAMES.USERS);
  const rowIndex = findRowIndexById_(sh, userId);
  if (rowIndex === -1) return { error: 'User not found.' };
  const headers = HEADERS.Users;
  const row = sh.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  const currentHash = row[headers.indexOf('PasswordHash')];
  if (currentHash !== hashPassword_(oldPassword)) return { error: 'Current password is incorrect.' };
  sh.getRange(rowIndex, headers.indexOf('PasswordHash') + 1).setValue(hashPassword_(newPassword));
  return { success: true };
}

/** ---- Admin-only user management ---- */

function requireAdmin_(currentUserRole) {
  if (currentUserRole !== 'Admin') throw new Error('Only an admin can do this.');
}

function listUsers(currentUserRole) {
  requireAdmin_(currentUserRole);
  return sheetToObjects_(getSheet(SHEET_NAMES.USERS)).map(function (u) {
    return {
      id: u.ID, name: u.Name, username: u.Username, role: u.Role,
      assignedBatchIds: (u.AssignedBatchIDs || '').split(',').map(function (s) { return s.trim(); }).filter(String),
      active: u.Active !== false
    };
  });
}

function createUser(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.USERS);
  const users = sheetToObjects_(sh);
  const usernameTaken = users.some(function (u) { return String(u.Username).toLowerCase() === String(data.username).toLowerCase(); });
  if (usernameTaken) return { error: 'That username is already taken.' };

  const id = Utilities.getUuid();
  sh.appendRow([
    id,
    data.name,
    data.username,
    hashPassword_(data.password || 'changeme123'),
    data.role === 'Admin' ? 'Admin' : 'Teacher',
    (data.assignedBatchIds || []).join(','),
    true,
    new Date()
  ]);
  return { success: true, id: id };
}

function updateUser(currentUserRole, data) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.USERS);
  const rowIndex = findRowIndexById_(sh, data.id);
  if (rowIndex === -1) return { error: 'User not found.' };
  const headers = HEADERS.Users;
  if (data.name != null) sh.getRange(rowIndex, headers.indexOf('Name') + 1).setValue(data.name);
  if (data.role != null) sh.getRange(rowIndex, headers.indexOf('Role') + 1).setValue(data.role);
  if (data.assignedBatchIds != null) sh.getRange(rowIndex, headers.indexOf('AssignedBatchIDs') + 1).setValue(data.assignedBatchIds.join(','));
  if (data.active != null) sh.getRange(rowIndex, headers.indexOf('Active') + 1).setValue(data.active);
  if (data.newPassword) sh.getRange(rowIndex, headers.indexOf('PasswordHash') + 1).setValue(hashPassword_(data.newPassword));
  return { success: true };
}

function deleteUser(currentUserRole, id) {
  requireAdmin_(currentUserRole);
  const sh = getSheet(SHEET_NAMES.USERS);
  const rowIndex = findRowIndexById_(sh, id);
  if (rowIndex === -1) return { error: 'User not found.' };
  sh.deleteRow(rowIndex);
  return { success: true };
}
