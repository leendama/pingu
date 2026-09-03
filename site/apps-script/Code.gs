// Pingu waitlist: appends one row per new email to a Google Sheet.
// Deploy as a Web app (execute as Me, access Anyone). See README.md.

var SHEET_ID = "PASTE_YOUR_SHEET_ID";
var SHEET_NAME = "waitlist";
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json({ ok: false, error: "bad_json" });
  }

  // Honeypot: bots fill the hidden "website" field. Pretend it worked, store nothing.
  if (body.website) return json({ ok: true });

  var email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return json({ ok: false, error: "invalid" });

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) return json({ ok: false, error: "no_sheet" });
    var lastRow = sheet.getLastRow();
    var existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); }) : [];
    if (existing.indexOf(email) === -1) {
      sheet.appendRow([email, new Date().toISOString(), String(body.referrer || "").slice(0, 500), String(body.ua || "").slice(0, 500)]);
    }
  } finally {
    lock.releaseLock();
  }
  return json({ ok: true });
}

function doGet() {
  return json({ ok: true, service: "pingu-waitlist" });
}

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
