// netlify/functions/timetable-pdf.js
// A4 landscape timetable renderer (PDFKit).
// Supports: class | teacher | master | duty.
//
// Request body:
//   { type, school: {name,address,phone,email,motto}, logoUrl,
//     term, year, ...typeSpecific }
//
// type=class:   { className, schedule }
// type=teacher: { teacher: {initials, fullName}, assignments: [{day, period, subject, className}] }
// type=master:  { level, classes: [..], schedules: { [cls]: schedule } }
// type=duty:    { roster }

const PDFDocument = require('pdfkit');
const axios = require('axios');

/* ============================================================
   Constants
   ============================================================ */

const COLORS = {
  navy: '#0f1a44',
  navyMid: '#1e2d73',
  gold: '#d4a017',
  slate: '#334155',
  gray: '#64748b',
  light: '#f1f5f9',
  border: '#cbd5e1',
  breakBg: '#fbf0cd',
  breakFg: '#8a6a10',
  white: '#ffffff',
};

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const CLASS_PERIODS = [
  { id: 'p1', name: 'Period 1', time: '08:00 - 08:40' },
  { id: 'p2', name: 'Period 2', time: '08:40 - 09:20' },
  { id: 'p3', name: 'Period 3', time: '09:50 - 10:30' },
  { id: 'p4', name: 'Period 4', time: '10:30 - 11:10' },
  { id: 'p5', name: 'Period 5', time: '11:10 - 11:50' },
  { id: 'p6', name: 'Period 6', time: '13:00 - 13:40' },
  { id: 'p7', name: 'Period 7', time: '13:40 - 14:20' },
  { id: 'p8', name: 'Period 8', time: '14:20 - 15:00' },
];

const BREAKS_INLINE = [
  { afterPeriodIndex: 1, label: 'TEA / RECREATION BREAK', time: '09:20 - 09:50' },
  { afterPeriodIndex: 4, label: 'NOON LUNCH BREAK', time: '11:50 - 13:00' },
];

const DUTY_AREAS = [
  { id: 'gate_morning', label: 'Main Gate (Morning)', time: '07:00 - 08:00' },
  { id: 'assembly',     label: 'Assembly Ground',     time: '08:00 - 08:20' },
  { id: 'break_duty',   label: 'Break Supervision',   time: '09:20 - 09:50' },
  { id: 'dining',       label: 'Dining Hall',         time: '12:00 - 13:00' },
  { id: 'gate_evening', label: 'Main Gate (Evening)', time: '15:00 - 16:30' },
  { id: 'library',      label: 'Library',             time: '15:00 - 16:30' },
  { id: 'playground',   label: 'Playground',          time: '16:00 - 17:00' },
  { id: 'dormitory',    label: 'Dormitory (Night)',   time: '21:00 - 22:00' },
];

const LEVEL_DISPLAY = {
  'pre-primary': 'Pre-Primary',
  'lower-primary': 'Lower Primary',
  'upper-primary': 'Upper Primary',
  'junior-school': 'Junior School',
  'senior-school': 'Senior School',
};

const MARGIN = 28;
const HEADER_LOGO = 46;
const FOOTER_H = 40;

/* ============================================================
   Logo cache (per cold start)
   ============================================================ */

const logoCache = new Map(); // url -> Buffer | null

async function fetchLogo(url) {
  if (!url || typeof url !== 'string') return null;
  if (logoCache.has(url)) return logoCache.get(url);
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'EduPriva-PDF/1.0' },
      maxContentLength: 3 * 1024 * 1024,
    });
    const buf = Buffer.from(res.data);
    const result = buf.length > 2 * 1024 * 1024 ? null : buf;
    logoCache.set(url, result);
    return result;
  } catch {
    logoCache.set(url, null);
    return null;
  }
}

/* ============================================================
   Header / footer
   ============================================================ */

function drawHeader(doc, school, logo, title, subtitle) {
  const pageW = doc.page.width;
  const y = MARGIN;

  if (logo) {
    try { doc.image(logo, MARGIN, y, { fit: [HEADER_LOGO, HEADER_LOGO] }); }
    catch { drawLogoPlaceholder(doc, MARGIN, y); }
  } else {
    drawLogoPlaceholder(doc, MARGIN, y);
  }

  const textX = MARGIN + HEADER_LOGO + 12;
  const rightW = 240;
  const textW = pageW - textX - MARGIN - rightW;

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(15)
    .text(school.name || 'School', textX, y + 2, { width: textW, ellipsis: true });

  const contactBits = [school.address, school.phone, school.email].filter(Boolean);
  if (contactBits.length) {
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(8)
      .text(contactBits.join('  |  '), textX, y + 24, { width: textW, ellipsis: true });
  }
  if (school.motto) {
    doc.fillColor(COLORS.navyMid).font('Helvetica-Oblique').fontSize(8)
      .text(school.motto, textX, y + 36, { width: textW, ellipsis: true });
  }

  doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(11)
    .text(title, pageW - MARGIN - rightW, y + 4, { width: rightW, align: 'right' });
  if (subtitle) {
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(9)
      .text(subtitle, pageW - MARGIN - rightW, y + 20, { width: rightW, align: 'right' });
  }

  const dividerY = y + HEADER_LOGO + 8;
  doc.moveTo(MARGIN, dividerY).lineTo(pageW - MARGIN, dividerY)
    .lineWidth(1.2).strokeColor(COLORS.navy).stroke();

  return dividerY + 12;
}

function drawLogoPlaceholder(doc, x, y) {
  doc.rect(x, y, HEADER_LOGO, HEADER_LOGO).fill(COLORS.navy);
  doc.fillColor(COLORS.gold).font('Helvetica-Bold').fontSize(18)
    .text('EP', x, y + 14, { width: HEADER_LOGO, align: 'center' });
}

function drawFooter(doc, school) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const y = pageH - FOOTER_H + 6;

  doc.moveTo(MARGIN, y).lineTo(pageW - MARGIN, y)
    .lineWidth(0.5).strokeColor(COLORS.border).stroke();

  const year = new Date().getFullYear();
  const left = `© ${year} ${school.name || 'School'}. All rights reserved.`;
  const right = `Generated ${new Date().toLocaleDateString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric',
  })}`;

  doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7.5)
    .text(left, MARGIN, y + 8, { width: pageW / 2 - MARGIN, align: 'left' });

  if (school.motto) {
    doc.fillColor(COLORS.navyMid).font('Helvetica-Oblique').fontSize(7.5)
      .text(school.motto, pageW / 2 - 80, y + 8, { width: 160, align: 'center' });
  }

  doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7.5)
    .text(right, pageW - MARGIN - pageW / 2, y + 8, { width: pageW / 2, align: 'right' });
}

/* ============================================================
   Class timetable (one per page)
   ============================================================ */

function drawClassTimetable(doc, school, logo, schedule, className, term, year) {
  const pageW = doc.page.width;
  const startY = drawHeader(
    doc, school, logo,
    'Class Master Timetable',
    `${className || ''} · ${term} ${year}`
  );

  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const timeColW = 80;
  const dayColW = (pageW - MARGIN * 2 - timeColW) / DAYS.length;

  const headerH = 22;
  const breakRowH = 16;
  const classRowH = (availableH - headerH - BREAKS_INLINE.length * breakRowH) / CLASS_PERIODS.length;

  // Header row
  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9)
    .text('Time / Day', MARGIN, y + 6, { width: timeColW, align: 'center' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + timeColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  const drawsBreak = (afterIndex) => {
    const br = BREAKS_INLINE.find((b) => b.afterPeriodIndex === afterIndex);
    if (!br) return false;
    doc.rect(MARGIN, y, pageW - MARGIN * 2, breakRowH).fill(COLORS.breakBg);
    doc.strokeColor(COLORS.border).lineWidth(0.5)
      .rect(MARGIN, y, pageW - MARGIN * 2, breakRowH).stroke();
    doc.fillColor(COLORS.breakFg).font('Helvetica-Bold').fontSize(7.5)
      .text(`${br.label}  (${br.time})`, MARGIN, y + (breakRowH - 8) / 2,
        { width: pageW - MARGIN * 2, align: 'center', characterSpacing: 1 });
    y += breakRowH;
    return true;
  };

  for (let i = 0; i < CLASS_PERIODS.length; i += 1) {
    const period = CLASS_PERIODS[i];

    // Time cell
    doc.rect(MARGIN, y, timeColW, classRowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5)
      .rect(MARGIN, y, timeColW, classRowH).stroke();
    doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(7.5)
      .text(period.name, MARGIN + 3, y + 4, { width: timeColW - 6, align: 'center' });
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5)
      .text(period.time, MARGIN + 3, y + 14, { width: timeColW - 6, align: 'center' });

    // Day cells
    for (let d = 0; d < DAYS.length; d += 1) {
      const day = DAYS[d];
      const cx = MARGIN + timeColW + dayColW * d;
      const slot = schedule?.[day]?.[period.id];
      doc.rect(cx, y, dayColW, classRowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();

      if (slot) {
        doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(7)
          .text(slot.subject || '', cx + 3, y + 4,
            { width: dayColW - 6, align: 'left', ellipsis: true });
        doc.fillColor(COLORS.navyMid).font('Helvetica-Bold').fontSize(7.5)
          .text(slot.teacherInitials || 'TBA', cx + 3, y + 15,
            { width: dayColW - 6, align: 'left' });
        if (slot.room) {
          doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6)
            .text(slot.room, cx + 3, y + 25,
              { width: dayColW - 6, align: 'left', ellipsis: true });
        }
      }
    }

    y += classRowH;
    drawsBreak(i);
  }

  drawFooter(doc, school);
}

/* ============================================================
   Teacher timetable (one per page)
   ============================================================ */

function drawTeacherTimetable(doc, school, logo, teacher, assignments, term, year) {
  const pageW = doc.page.width;
  const startY = drawHeader(
    doc, school, logo,
    'Teacher Timetable',
    `${teacher.fullName || ''} (${teacher.initials || ''}) · ${term} ${year}`
  );

  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const timeColW = 80;
  const dayColW = (pageW - MARGIN * 2 - timeColW) / DAYS.length;

  const headerH = 22;
  const rowH = (availableH - headerH) / CLASS_PERIODS.length;

  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9)
    .text('Time / Day', MARGIN, y + 6, { width: timeColW, align: 'center' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + timeColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  for (const period of CLASS_PERIODS) {
    doc.rect(MARGIN, y, timeColW, rowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(MARGIN, y, timeColW, rowH).stroke();
    doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(7.5)
      .text(period.name, MARGIN + 3, y + rowH / 2 - 8,
        { width: timeColW - 6, align: 'center' });
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5)
      .text(period.time, MARGIN + 3, y + rowH / 2 + 2,
        { width: timeColW - 6, align: 'center' });

    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[i];
      const cx = MARGIN + timeColW + dayColW * i;
      const slot = assignments.find((a) => a.day === day && a.period.id === period.id);

      doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      if (slot) {
        doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(7)
          .text(slot.subject, cx + 3, y + 5,
            { width: dayColW - 6, align: 'left', ellipsis: true });
        doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5)
          .text(slot.className, cx + 3, y + 16, { width: dayColW - 6, align: 'left' });
      }
    }
    y += rowH;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Master overview (one level per page, page-breaking as needed)
   ============================================================ */

function drawMasterByLevel(doc, school, logo, level, classes, schedules, term, year) {
  const pageW = doc.page.width;
  const levelName = LEVEL_DISPLAY[level] || level;
  const startY = drawHeader(
    doc, school, logo,
    'Master Timetable Overview',
    `${levelName} · ${term} ${year}`
  );

  const footerTop = doc.page.height - FOOTER_H;
  let y = startY + 4;

  const timeColW = 70;
  const dayColW = (pageW - MARGIN * 2 - timeColW) / DAYS.length;
  const headerH = 14;
  const rowH = 16;

  const ensureSpace = (needed) => {
    if (y + needed > footerTop) {
      doc.addPage();
      drawHeader(doc, school, logo, 'Master Timetable Overview', `${levelName} · ${term} ${year}`);
      y = startY + 4;
    }
  };

  for (const cls of classes) {
    const schedule = schedules[cls] || {};
    const stripH = 14;
    ensureSpace(stripH + headerH + 40);

    doc.rect(MARGIN, y, pageW - MARGIN * 2, stripH).fill(COLORS.navy);
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(8)
      .text(String(cls).toUpperCase(), MARGIN + 6, y + 3,
        { width: pageW - MARGIN * 2, align: 'left' });
    y += stripH;

    doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.light);
    doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(7)
      .text('Time', MARGIN, y + 4, { width: timeColW, align: 'center' });
    for (let i = 0; i < DAYS.length; i += 1) {
      const cx = MARGIN + timeColW + dayColW * i;
      doc.text(DAYS[i].slice(0, 3).toUpperCase(), cx, y + 4, { width: dayColW, align: 'center' });
    }
    y += headerH;

    for (const period of CLASS_PERIODS) {
      doc.rect(MARGIN, y, timeColW, rowH).fill(COLORS.light);
      doc.strokeColor(COLORS.border).lineWidth(0.4).rect(MARGIN, y, timeColW, rowH).stroke();
      doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5)
        .text(period.name.replace('Period ', 'P'), MARGIN, y + 5,
          { width: timeColW, align: 'center' });

      for (let i = 0; i < DAYS.length; i += 1) {
        const day = DAYS[i];
        const cx = MARGIN + timeColW + dayColW * i;
        const slot = schedule?.[day]?.[period.id];
        doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.4).stroke();
        if (slot) {
          doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(6)
            .text(slot.subject || '', cx + 2, y + 2,
              { width: dayColW - 4, align: 'center', ellipsis: true });
          doc.fillColor(COLORS.navyMid).font('Helvetica-Bold').fontSize(6)
            .text(slot.teacherInitials || '', cx + 2, y + 9,
              { width: dayColW - 4, align: 'center' });
        }
      }
      y += rowH;
    }
    y += 6;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Duty roster
   ============================================================ */

function drawDutyRoster(doc, school, logo, roster, term, year) {
  const pageW = doc.page.width;
  const startY = drawHeader(doc, school, logo, 'Weekly Duty Roster', `${term} ${year}`);

  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const areaColW = 150;
  const dayColW = (pageW - MARGIN * 2 - areaColW) / DAYS.length;
  const headerH = 22;
  const rowH = (availableH - headerH) / DUTY_AREAS.length;

  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9)
    .text('Duty Area / Time', MARGIN + 4, y + 6, { width: areaColW, align: 'left' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + areaColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  for (const area of DUTY_AREAS) {
    doc.rect(MARGIN, y, areaColW, rowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(MARGIN, y, areaColW, rowH).stroke();
    doc.fillColor(COLORS.slate).font('Helvetica-Bold').fontSize(7.5)
      .text(area.label, MARGIN + 4, y + 5, { width: areaColW - 8, align: 'left' });
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5)
      .text(area.time, MARGIN + 4, y + 14, { width: areaColW - 8, align: 'left' });

    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[i];
      const cx = MARGIN + areaColW + dayColW * i;
      const entry = roster?.[day]?.[area.id];
      doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      if (entry) {
        doc.fillColor(COLORS.navyMid).font('Helvetica-Bold').fontSize(8)
          .text(entry.teacherInitials || '', cx + 2, y + 4,
            { width: dayColW - 4, align: 'center' });
        doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6)
          .text(entry.teacherFullName || '', cx + 2, y + 14,
            { width: dayColW - 4, align: 'center', ellipsis: true });
      }
    }
    y += rowH;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Handler
   ============================================================ */

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const {
    type,
    school = {},
    logoUrl,
    term = 'Term 1',
    year = new Date().getFullYear(),
  } = payload;

  const logo = await fetchLogo(logoUrl || school.logoUrl || school.schoolLogo);

  const chunks = [];
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.on('data', (c) => chunks.push(c));

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  try {
    switch (type) {
      case 'class':
        drawClassTimetable(doc, school, logo, payload.schedule || {}, payload.className || '', term, year);
        break;
      case 'teacher':
        drawTeacherTimetable(doc, school, logo, payload.teacher || {}, payload.assignments || [], term, year);
        break;
      case 'master':
        drawMasterByLevel(doc, school, logo, payload.level || '', payload.classes || [], payload.schedules || {}, term, year);
        break;
      case 'duty':
        drawDutyRoster(doc, school, logo, payload.roster || {}, term, year);
        break;
      default:
        return json(400, { error: 'Unknown type' });
    }

    doc.end();
    const pdfBuffer = await done;

    const safe = (s) => String(s || '').replace(/[^\w-]/g, '');
    const filename = `Timetable_${safe(
      payload.className || payload.teacher?.initials || payload.level || 'Roster'
    )}_${safe(term)}_${year}.pdf`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Cache-Control': 'no-store',
      },
      body: pdfBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[timetable-pdf] render error:', err);
    return json(500, { error: err.message || 'PDF generation failed' });
  }
};
