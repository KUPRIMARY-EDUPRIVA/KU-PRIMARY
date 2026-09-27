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
//
// Styling matches generate-student-report.js, generate-teacher-reports.js,
// and generate-ranking.js:
//   - Letterhead-style header (logo left, school name / motto / contact stack)
//     with a coloured underline rule
//   - Times New Roman typography (PDFKit standard-14 Times family)
//   - Images opened once as reusable PDF XObjects (multi-page size win)
//   - Early size guard rejects oversized requests with a 413 before PDFKit
//     starts streaming

const PDFDocument = require('pdfkit');
const axios = require('axios');

/* ============================================================
   Constants
   ============================================================ */

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

const MAX_RESPONSE_BYTES = 5_500_000;
const ESTIMATE_HEADROOM = 0.7;

// Per-section size estimate (bytes) used for the early guard.
// A "section" is one timetable block (one class, one teacher, one level
// strip, or one duty area). Conservative.
const EST_BYTES_PER_SECTION = 8_000;

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

// Letterhead colours (shared with the other reports)
const HEADER_BLUE = '#1a4e8a';
const HEADER_RULE_WIDTH = 1.4;
const HEADER_MOTTO_GRAY = '#666';
const HEADER_CONTACT_GRAY = '#333';

// Times New Roman family (PDFKit standard-14 names)
const FONT_REGULAR = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';
const FONT_BOLD_ITALIC = 'Times-BoldItalic';

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
   Image fetch (per cold start cache)
   ============================================================ */

const logoCache = new Map(); // url -> Buffer | null

async function fetchImageBuffer(url, maxBytes = 2 * 1024 * 1024) {
  if (!url || typeof url !== 'string') return null;
  if (logoCache.has(url)) return logoCache.get(url);
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'EduPriva-PDF/5.0' },
      maxRedirects: 5,
      maxContentLength: 3 * 1024 * 1024,
    });
    const buf = Buffer.from(res.data);
    if (buf.length === 0 || buf.length > maxBytes) {
      logoCache.set(url, null);
      return null;
    }
    logoCache.set(url, buf);
    return buf;
  } catch (e) {
    console.warn(`[timetable-pdf] logo fetch failed for ${url}:`, e.message);
    logoCache.set(url, null);
    return null;
  }
}

/* ============================================================
   Primitives
   ============================================================ */

function drawImage(doc, img, cx, cy, w, h) {
  if (!img) return false;
  try {
    doc.image(img, cx, cy, { fit: [w, h], align: 'center', valign: 'center' });
    return true;
  } catch (e) {
    console.warn('[timetable-pdf] image embed failed:', e.message);
    return false;
  }
}

/**
 * Compose a letterhead-style header and return the y below the rule.
 * Identical geometry to the other three reports so every document
 * produced by the system matches.
 *
 * `title` and `subtitle` are rendered right-aligned on the header band,
 * so the timetable type is still identifiable at a glance.
 */
function drawLetterheadHeader(doc, {
  x, y, w,
  school, logoImg,
  title, subtitle,
  logoSize = HEADER_LOGO,
  padding = 10,
  nameSize = 14,
  mottoSize = 8.5,
  contactSize = 7.5,
  lineGap = 2.5,
  ruleGap = 6,
}) {
  const logoX = x;
  const logoY = y;
  const hasLogo = drawImage(doc, logoImg, logoX, logoY, logoSize, logoSize);

  if (!hasLogo) {
    doc.rect(logoX, logoY, logoSize, logoSize)
      .lineWidth(0.6).strokeColor(COLORS.border).stroke();
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor('#bbb')
      .text('NO\nLOGO', logoX, logoY + logoSize / 2 - 6, {
        width: logoSize, align: 'center', lineGap: 2,
      });
  }

  const rightW = 200;
  const textX = logoX + logoSize + padding;
  const textW = w - logoSize - padding - rightW - 8;

  // School name (left, dominant)
  doc.font(FONT_BOLD).fontSize(nameSize).fillColor(HEADER_BLUE)
    .text((school.name || FALLBACK_NAME).toUpperCase(), textX, y + 1, {
      width: Math.max(80, textW), align: 'left', ellipsis: true,
    });
  let cy = y + nameSize + 3;

  // Contact stack (left)
  doc.font(FONT_REGULAR).fontSize(contactSize).fillColor(HEADER_CONTACT_GRAY);
  const contactLines = [];
  if (school.address) contactLines.push(String(school.address));
  if (school.phone) contactLines.push(`Tel: ${school.phone}`);
  if (school.email) contactLines.push(`Email: ${school.email}`);
  if (school.website) contactLines.push(`Website: ${school.website}`);

  for (const line of contactLines) {
    doc.text(line, textX, cy, {
      width: Math.max(80, textW), align: 'left', ellipsis: true, lineBreak: false,
    });
    cy += contactSize + lineGap;
  }

  // Motto (left, italic)
  if (school.motto) {
    doc.font(FONT_ITALIC).fontSize(mottoSize).fillColor(HEADER_MOTTO_GRAY)
      .text(`Motto: ${school.motto}`, textX, cy, {
        width: Math.max(80, textW), align: 'left', ellipsis: true,
      });
    cy += mottoSize + lineGap;
  }

  // Title / subtitle (right-aligned on the header band)
  const titleX = x + w - rightW;
  doc.font(FONT_BOLD).fontSize(11.5).fillColor(COLORS.slate)
    .text(title || '', titleX, y + 4, { width: rightW, align: 'right' });
  if (subtitle) {
    doc.font(FONT_ITALIC).fontSize(9).fillColor(COLORS.gray)
      .text(subtitle, titleX, y + 22, { width: rightW, align: 'right' });
  }

  const blockBottom = Math.max(cy, logoY + logoSize) + ruleGap;
  doc.moveTo(x, blockBottom).lineTo(x + w, blockBottom)
    .lineWidth(HEADER_RULE_WIDTH).strokeColor(HEADER_BLUE).stroke();

  return blockBottom + 8;
}

function drawFooter(doc, school) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const y = pageH - FOOTER_H + 6;

  doc.moveTo(MARGIN, y).lineTo(pageW - MARGIN, y)
    .lineWidth(0.5).strokeColor(COLORS.border).stroke();

  const year = new Date().getFullYear();
  const left = `© ${year} ${school.name || FALLBACK_NAME}. All rights reserved.`;
  const right = `Generated ${new Date().toLocaleDateString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric',
  })}`;

  doc.font(FONT_REGULAR).fontSize(7.5).fillColor(COLORS.gray)
    .text(left, MARGIN, y + 8, { width: pageW / 2 - MARGIN, align: 'left' });

  if (school.motto) {
    doc.font(FONT_ITALIC).fontSize(7.5).fillColor(COLORS.navyMid)
      .text(school.motto, pageW / 2 - 80, y + 8, { width: 160, align: 'center' });
  }

  doc.font(FONT_REGULAR).fontSize(7.5).fillColor(COLORS.gray)
    .text(right, pageW - MARGIN - pageW / 2, y + 8, { width: pageW / 2, align: 'right' });
}

/* ============================================================
   Class timetable (one per page)
   ============================================================ */

function drawClassTimetable(doc, school, logoImg, schedule, className, term, year) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Class Master Timetable',
    subtitle: `${className || ''} · ${term} ${year}`,
  });

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
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.white)
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
    doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.breakFg)
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
    doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.slate)
      .text(period.name, MARGIN + 3, y + 4, { width: timeColW - 6, align: 'center' });
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
      .text(period.time, MARGIN + 3, y + 14, { width: timeColW - 6, align: 'center' });

    // Day cells
    for (let d = 0; d < DAYS.length; d += 1) {
      const day = DAYS[d];
      const cx = MARGIN + timeColW + dayColW * d;
      const slot = schedule?.[day]?.[period.id];
      doc.rect(cx, y, dayColW, classRowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();

      if (slot) {
        doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.slate)
          .text(slot.subject || '', cx + 3, y + 4,
            { width: dayColW - 6, align: 'left', ellipsis: true });
        doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.navyMid)
          .text(slot.teacherInitials || 'TBA', cx + 3, y + 15,
            { width: dayColW - 6, align: 'left' });
        if (slot.room) {
          doc.font(FONT_REGULAR).fontSize(6).fillColor(COLORS.gray)
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

function drawTeacherTimetable(doc, school, logoImg, teacher, assignments, term, year) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Teacher Timetable',
    subtitle: `${teacher.fullName || ''} (${teacher.initials || ''}) · ${term} ${year}`,
  });

  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const timeColW = 80;
  const dayColW = (pageW - MARGIN * 2 - timeColW) / DAYS.length;

  const headerH = 22;
  const rowH = (availableH - headerH) / CLASS_PERIODS.length;

  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.white)
    .text('Time / Day', MARGIN, y + 6, { width: timeColW, align: 'center' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + timeColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  for (const period of CLASS_PERIODS) {
    doc.rect(MARGIN, y, timeColW, rowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(MARGIN, y, timeColW, rowH).stroke();
    doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.slate)
      .text(period.name, MARGIN + 3, y + rowH / 2 - 8,
        { width: timeColW - 6, align: 'center' });
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
      .text(period.time, MARGIN + 3, y + rowH / 2 + 2,
        { width: timeColW - 6, align: 'center' });

    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[i];
      const cx = MARGIN + timeColW + dayColW * i;
      const slot = assignments.find((a) => a.day === day && a.period.id === period.id);

      doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      if (slot) {
        doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.navy)
          .text(slot.subject, cx + 3, y + 5,
            { width: dayColW - 6, align: 'left', ellipsis: true });
        doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
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

function drawMasterByLevel(doc, school, logoImg, level, classes, schedules, term, year) {
  const pageW = doc.page.width;
  const levelName = LEVEL_DISPLAY[level] || level;
  const title = 'Master Timetable Overview';
  const subtitle = `${levelName} · ${term} ${year}`;

  let y = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title, subtitle,
  });

  const footerTop = doc.page.height - FOOTER_H;

  const timeColW = 70;
  const dayColW = (pageW - MARGIN * 2 - timeColW) / DAYS.length;
  const headerH = 14;
  const rowH = 16;

  const ensureSpace = (needed) => {
    if (y + needed > footerTop) {
      doc.addPage();
      y = drawLetterheadHeader(doc, {
        x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
        school, logoImg,
        title, subtitle,
      });
    }
  };

  for (const cls of classes) {
    const schedule = schedules[cls] || {};
    const stripH = 14;
    ensureSpace(stripH + headerH + 40);

    doc.rect(MARGIN, y, pageW - MARGIN * 2, stripH).fill(COLORS.navy);
    doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.white)
      .text(String(cls).toUpperCase(), MARGIN + 6, y + 3,
        { width: pageW - MARGIN * 2, align: 'left' });
    y += stripH;

    doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.light);
    doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.slate)
      .text('Time', MARGIN, y + 4, { width: timeColW, align: 'center' });
    for (let i = 0; i < DAYS.length; i += 1) {
      const cx = MARGIN + timeColW + dayColW * i;
      doc.text(DAYS[i].slice(0, 3).toUpperCase(), cx, y + 4, { width: dayColW, align: 'center' });
    }
    y += headerH;

    for (const period of CLASS_PERIODS) {
      doc.rect(MARGIN, y, timeColW, rowH).fill(COLORS.light);
      doc.strokeColor(COLORS.border).lineWidth(0.4).rect(MARGIN, y, timeColW, rowH).stroke();
      doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
        .text(period.name.replace('Period ', 'P'), MARGIN, y + 5,
          { width: timeColW, align: 'center' });

      for (let i = 0; i < DAYS.length; i += 1) {
        const day = DAYS[i];
        const cx = MARGIN + timeColW + dayColW * i;
        const slot = schedule?.[day]?.[period.id];
        doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.4).stroke();
        if (slot) {
          doc.font(FONT_BOLD).fontSize(6).fillColor(COLORS.slate)
            .text(slot.subject || '', cx + 2, y + 2,
              { width: dayColW - 4, align: 'center', ellipsis: true });
          doc.font(FONT_BOLD).fontSize(6).fillColor(COLORS.navyMid)
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

function drawDutyRoster(doc, school, logoImg, roster, term, year) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Weekly Duty Roster',
    subtitle: `${term} ${year}`,
  });

  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const areaColW = 150;
  const dayColW = (pageW - MARGIN * 2 - areaColW) / DAYS.length;
  const headerH = 22;
  const rowH = (availableH - headerH) / DUTY_AREAS.length;

  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.white)
    .text('Duty Area / Time', MARGIN + 4, y + 6, { width: areaColW, align: 'left' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + areaColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  for (const area of DUTY_AREAS) {
    doc.rect(MARGIN, y, areaColW, rowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(MARGIN, y, areaColW, rowH).stroke();
    doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.slate)
      .text(area.label, MARGIN + 4, y + 5, { width: areaColW - 8, align: 'left' });
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
      .text(area.time, MARGIN + 4, y + 14, { width: areaColW - 8, align: 'left' });

    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[i];
      const cx = MARGIN + areaColW + dayColW * i;
      const entry = roster?.[day]?.[area.id];
      doc.rect(cx, y, dayColW, rowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      if (entry) {
        doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.navyMid)
          .text(entry.teacherInitials || '', cx + 2, y + 4,
            { width: dayColW - 4, align: 'center' });
        doc.font(FONT_REGULAR).fontSize(6).fillColor(COLORS.gray)
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

  if (!['class', 'teacher', 'master', 'duty'].includes(type)) {
    return json(400, { error: 'Unknown type' });
  }

  // Early size guard based on the estimated number of "sections" this
  // request will render. Conservative but effective.
  const sectionCount =
    type === 'class' ? 1
    : type === 'teacher' ? 1
    : type === 'duty' ? 1
    : (Array.isArray(payload.classes) ? payload.classes.length : 1);
  const estBytes = Math.max(1, sectionCount) * EST_BYTES_PER_SECTION;
  const safeBudget = MAX_RESPONSE_BYTES * ESTIMATE_HEADROOM;
  if (estBytes > safeBudget) {
    return json(413, {
      error:
        `Estimated PDF size (${(estBytes / 1_048_576).toFixed(1)} MB) exceeds the ` +
        `${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB response budget. ` +
        `Split into smaller requests.`,
    });
  }

  // Accept every plausible logo field name
  const resolvedLogoUrl = logoUrl || school.logoUrl || school.schoolLogo || school.logo || '';
  const logoBuffer = await fetchImageBuffer(resolvedLogoUrl);

  console.log('[timetable-pdf] image fetch status', {
    type,
    hasLogoUrl: !!resolvedLogoUrl,
    logoBytes: logoBuffer ? logoBuffer.length : 0,
  });

  const chunks = [];
  let total = 0;
  let aborted = false;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    autoFirstPage: false,
    compress: true,
    info: {
      Title: `Timetable — ${type}`,
      Author: school.name || FALLBACK_NAME,
      Creator: 'EduPriva',
    },
  });

  doc.on('data', (c) => {
    if (aborted) return;
    chunks.push(c);
    total += c.length;
    if (total > MAX_RESPONSE_BYTES) {
      aborted = true;
      doc.destroy(new Error(
        `PDF exceeded ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit`
      ));
    }
  });

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks, total)));
    doc.on('error', reject);
  });

  // Set the document-wide default font once
  doc.font(FONT_REGULAR);

  // Open the logo once as a reusable XObject
  let logoImg = null;
  if (logoBuffer) {
    try { logoImg = doc.openImage(logoBuffer); }
    catch (e) { console.warn('[timetable-pdf] openImage failed for logo:', e.message); }
  }

  try {
    switch (type) {
      case 'class':
        doc.addPage({ layout: 'landscape' });
        drawClassTimetable(
          doc, school, logoImg,
          payload.schedule || {},
          payload.className || '',
          term, year
        );
        break;
      case 'teacher':
        doc.addPage({ layout: 'landscape' });
        drawTeacherTimet
