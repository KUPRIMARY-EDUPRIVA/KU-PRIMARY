// src/services/timetablePdfClient.js
/**
 * Thin client for the Netlify timetable-pdf function.
 *
 * Accepts the school's live period/duty configuration so exported PDFs
 * match whatever the admin has configured in Settings.
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

/**
 * Extract only the fields we actually want to send to the function.
 * Keeps payload size small and avoids leaking extra Firestore metadata.
 */
function packPeriods(periods) {
  if (!Array.isArray(periods)) return undefined;
  return periods.map((p) => ({
    id: p.id,
    name: p.name,
    start: p.start,
    end: p.end,
    type: p.type || 'class',
    label: p.label || p.name,
  }));
}

function packDutyAreas(areas) {
  if (!Array.isArray(areas)) return undefined;
  return areas.map((a) => ({
    id: a.id,
    label: a.label,
    start: a.start,
    end: a.end,
  }));
}

function packLevelDisplay(levels) {
  if (!levels || typeof levels !== 'object') return undefined;
  return levels;
}

export async function downloadClassTimetablePDF({
  school, logoUrl, className, schedule, term, year,
  periods, levelDisplay,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'class',
    school, logoUrl, className, schedule, term, year,
    periods: packPeriods(periods),
    levelDisplay: packLevelDisplay(levelDisplay),
  });
  triggerDownload(blob, `Timetable_${className || 'Class'}_${term}_${year}.pdf`);
}

export async function downloadTeacherTimetablePDF({
  school, logoUrl, teacher, assignments, term, year,
  periods, levelDisplay,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'teacher',
    school, logoUrl, teacher, assignments, term, year,
    periods: packPeriods(periods),
    levelDisplay: packLevelDisplay(levelDisplay),
  });
  triggerDownload(blob, `Timetable_${teacher?.initials || 'Teacher'}_${term}_${year}.pdf`);
}

export async function downloadMasterTimetablePDF({
  school, logoUrl, level, levelLabel, classes, schedules, term, year,
  periods, levelDisplay,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'master',
    school, logoUrl, level, levelLabel, classes, schedules, term, year,
    periods: packPeriods(periods),
    levelDisplay: packLevelDisplay(levelDisplay),
  });
  triggerDownload(blob, `Timetable_Master_${levelLabel || level}_${term}_${year}.pdf`);
}

export async function downloadDutyRosterPDF({
  school, logoUrl, roster, term, year,
  dutyAreas, levelDisplay,
}) {
  const blob = await postJSON('/api/timetable-pdf', {
    type: 'duty',
    school, logoUrl, roster, term, year,
    dutyAreas: packDutyAreas(dutyAreas),
    levelDisplay: packLevelDisplay(levelDisplay),
  });
  triggerDownload(blob, `Duty_Roster_${term}_${year}.pdf`);
}
