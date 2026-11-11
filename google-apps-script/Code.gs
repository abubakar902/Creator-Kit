/**
 * TrivexaAI feedback receiver for a Google Sheet-bound Apps Script.
 * Create/open your Google Sheet, then paste this into Extensions > Apps Script.
 * No API keys or public sheet sharing are required.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const data = (e && e.parameter) ? e.parameter : {};
    if (String(data.website || '').trim()) {
      return json_({ ok: true });
    }

    const rating = Number(data.rating);
    const type = String(data.type || '').trim();
    const message = String(data.message || '').trim();
    const page = String(data.page || 'TrivexaAI feedback page').slice(0, 500);

    const allowedTypes = [
      'General review',
      'Report a problem',
      'Suggest a new tool',
      'Feature improvement'
    ];

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return json_({ ok: false, error: 'Invalid rating.' });
    }
    if (allowedTypes.indexOf(type) === -1) {
      return json_({ ok: false, error: 'Invalid feedback type.' });
    }
    if (message.length < 5 || message.length > 2000) {
      return json_({ ok: false, error: 'Feedback must be 5 to 2000 characters.' });
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('This script must be attached to the TrivexaAI feedback spreadsheet.');
    }

    let sheet = spreadsheet.getSheetByName('Feedback');
    if (!sheet) sheet = spreadsheet.insertSheet('Feedback');

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Rating', 'Feedback Type', 'Message', 'Page']);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    sheet.appendRow([new Date(), rating, type, message, page]);
    return json_({ ok: true });
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: 'Could not save feedback.' });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function doGet() {
  return json_({ ok: true, service: 'TrivexaAI feedback receiver is running.' });
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}