// src/services/timetablePdfClient.js
/**
 * Thin client for the Netlify timetable-pdf function.
 * Mirrors the payload shapes the function expects.
 */

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(`PDF service failed (${res.status}) ${detail}`.trim());
  }
  return res.blob();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadClassTimetablePDF({
  school, logoUrl, className, schedule, term, year,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'class',
    school, logoUrl, className, schedule, term, year,
  });
  triggerDownload(blob, `Timetable_${className || 'Class'}_${term}_${year}.pdf`);
}

export async function downloadTeacherTimetablePDF({
  school, logoUrl, teacher, assignments, term, year,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'teacher',
    school, logoUrl, teacher, assignments, term, year,
  });
  triggerDownload(blob, `Timetable_${teacher?.initials || 'Teacher'}_${term}_${year}.pdf`);
}

export async function downloadMasterTimetablePDF({
  school, logoUrl, level, classes, schedules, term, year,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'master',
    school, logoUrl, level, classes, schedules, term, year,
  });
  triggerDownload(blob, `Timetable_Master_${level}_${term}_${year}.pdf`);
}

export async function downloadDutyRosterPDF({
  school, logoUrl, roster, term, year,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'duty',
    school, logoUrl, roster, term, year,
  });
  triggerDownload(blob, `Duty_Roster_${term}_${year}.pdf`);
}
