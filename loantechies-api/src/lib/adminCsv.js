// Port of Admin/AdminModels.cs's AdminCsv — pure RFC-4180 CSV builder for the leads export.

export function csvField(s) {
  s = s == null ? '' : String(s);
  return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// C#'s DateTime.ToString("u") — universal sortable, always "yyyy-MM-dd HH:mm:ssZ". Input here is
// already an ISO 8601 string (from http.js's toIso()); reshape rather than reparse.
function uFmt(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function leadsToCsv(items) {
  let out = 'ID,First Name,Last Name,Email,Phone,Language,Loan Type,Created (UTC),Verified (UTC),Updated (UTC),Has Form Data,Status,Temperature,Source,Follow-up (UTC),Updated By\r\n';
  for (const x of items || []) {
    out += [
      csvField(x.id), csvField(x.firstName), csvField(x.lastName), csvField(x.email),
      csvField(x.phone), csvField(x.lang), csvField(x.loanType),
      csvField(uFmt(x.createdUtc)), csvField(uFmt(x.verifiedUtc)), csvField(uFmt(x.updatedUtc)),
      csvField(x.hasFormData ? 'yes' : 'no'),
      csvField(x.status), csvField(x.temperature), csvField(x.source),
      csvField(uFmt(x.followUpUtc)), csvField(x.updatedBy),
    ].join(',');
    out += '\r\n';
  }
  return out;
}
