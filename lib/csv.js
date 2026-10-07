// Minimal CSV writer.
//
// Every field is quoted, with inner quotes doubled. Fields starting with
// = + - @ (or tab/CR) get a leading apostrophe: otherwise Excel/Sheets
// would run a ticket title like `=HYPERLINK(...)` as a formula when a
// manager opens the export ("CSV injection").
function cell(value) {
  if (value === null || value === undefined) return '""';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  rows.forEach((row) => lines.push(row.map(cell).join(',')));
  // BOM so Excel reads it as UTF-8; CRLF line endings per RFC 4180.
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, cell };
