// netlify/functions/timetable-pdf.js
// A4 landscape timetable renderer (PDFKit).
// Supports: class | teacher | master | duty.
//
// Layout convention (updated):
//   - Columns = Days of the week (Monday … Friday)
//   - Rows    = Periods, with time / duration in the left column
//   - Breaks  span all columns
//   - Duty roster keeps days as columns, duty areas as rows
//
// Request body:
//   {
//     type,
//     school: { name, address, phone, email, motto, website, logoUrl },
//     logoUrl,
//     term, year,
//
//     periods:     [{ id, name, start, end, type: 'class'|'break', label? }],
//     breaks:      [{ id, name, start, end, label }],
//     dutyAreas:   [{ id, label, start, end, time? }],
//     levelDisplay:{ 'lower-primary': 'Lower Primary', ... },
//     levelLabel:  'Lower Primary',
//
//     className, schedule,                 // class
//     teacher, assignments,                // teacher
//     level, classes: [...], schedules: {},// master
//     roster,                              // duty
//   }

const PDFDocument = require('pdfkit');
const axios = require('axios');

/* ============================================================
   Constants
   ============================================================ */

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

const MAX_RESPONSE_BYTES = 5_500_000;
const ESTIMATE_HEADROOM = 0.7;
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

const HEADER_BLUE = '#1a4e8a';
const HEADER_RULE_WIDTH = 1.4;
const HEADER_MOTTO_GRAY = '#666';
const HEADER_CONTACT_GRAY = '#333';

const FONT_REGULAR = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DAY_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

const MARGIN = 28;
const HEADER_LOGO = 46;
const FOOTER_H = 40;

/* ============================================================
   Defaults (used only when the client doesn't send overrides)
   ============================================================ */

const DEFAULT_PERIODS = [
  { id: 'p1', name: 'Period 1', start: '08:00', end: '08:40', type: 'class' },
  { id: 'p2', name: 'Period 2', start: '08:40', end: '09:20', type: 'class' },
  { id: 'break1', name: 'Morning Break', start: '09:20', end: '09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
  { id: 'p3', name: 'Period 3', start: '09:50', end: '10:30', type: 'class' },
  { id: 'p4', name: 'Period 4', start: '10:30', end: '11:10', type: 'class' },
  { id: 'p5', name: 'Period 5', start: '11:10', end: '11:50', type: 'class' },
  { id: 'lunch', name: 'Lunch Break', start: '11:50', end: '13:00', type: 'break', label: 'NOON LUNCH BREAK' },
  { id: 'p6', name: 'Period 6', start: '13:00', end: '13:40', type: 'class' },
  { id: 'p7', name: 'Period 7', start: '13:40', end: '14:20', type: 'class' },
  { id: 'p8', name: 'Period 8', start: '14:20', end: '15:00', type: 'class' },
];

const DEFAULT_DUTY_AREAS = [
  { id: 'gate_morning', label: 'Main Gate (Morning)', start: 7,    end: 8 },
  { id: 'assembly',     label: 'Assembly Ground',     start: 8,    end: 8.33 },
  { id: 'break_duty',   label: 'Break Supervision',   start: 9.33, end: 9.83 },
  { id: 'dining',       label: 'Dining Hall',         start: 12,   end: 13 },
  { id: 'gate_evening', label: 'Main Gate (Evening)', start: 15,   end: 16.5 },
  { id: 'library',      label: 'Library',             start: 15,   end: 16.5 },
  { id: 'playground',   label: 'Playground',          start: 16,   end: 17 },
  { id: 'dormitory',    label: 'Dormitory (Night)',   start: 21,   end: 22 },
];

const DEFAULT_LEVEL_DISPLAY = {
  'pre-primary': 'Pre-Primary',
  'lower-primary': 'Lower Primary',
  'upper-primary': 'Upper Primary',
  'junior-school': 'Junior School',
  'senior-school': 'Senior School',
};

/* ============================================================
   Payload normalisation
   ============================================================ */

function periodTime(p) {
  if (p.time) return p.time;
  if (p.start && p.end) return `${p.start} - ${p.end}`;
  return '';
}

/** Decimal hours (7.5) → "07:30". */
function decimalToHHMM(h) {
  if (typeof h === 'string' && h.includes(':')) return h;
  const num = Number(h);
  if (!Number.isFinite(num)) return '';
  const whole = Math.floor(num);
  const mins = Math.round((num - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function dutyTime(a) {
  if (a.time) return a.time;
  if (a.start == null || a.end == null) return '';
  return `${decimalToHHMM(a.start)} - ${decimalToHHMM(a.end)}`;
}

/** Duration in minutes between two HH:MM strings. Returns null if unknown. */
function periodDuration(start, end) {
  if (!start || !end) return null;
  const s = String(start).split(':').map(Number);
  const e = String(end).split(':').map(Number);
  if (s.length < 2 || e.length < 2) return null;
  if (!Number.isFinite(s[0]) || !Number.isFinite(e[0])) return null;
  const mins = (e[0] * 60 + (e[1] || 0)) - (s[0] * 60 + (s[1] || 0));
  return mins > 0 ? mins : null;
}

function normalizePeriods(payload) {
  if (Array.isArray(payload.periods) && payload.periods.length) {
    return payload.periods.map((p) => ({
      id: p.id,
      name: p.name || (p.type === 'break' ? 'Break' : 'Period'),
      start: p.start || '',
      end: p.end || '',
      time: periodTime(p),
      duration: p.duration || periodDuration(p.start, p.end),
      type: p.type === 'break' ? 'break' : 'class',
      label: p.label || p.name || 'BREAK',
    }));
  }

  if (Array.isArray(payload.breaks) && payload.breaks.length) {
    const classes = (Array.isArray(payload.periods) ? payload.periods : [])
      .filter((p) => p.type !== 'break')
      .map((p) => ({
        id: p.id,
        name: p.name,
        start: p.start || '',
        end: p.end || '',
        time: periodTime(p),
        duration: periodDuration(p.start, p.end),
        type: 'class',
        startSort: p.start || '',
      }));
    const breaks = payload.breaks.map((b) => ({
      id: b.id,
      name: b.name,
      start: b.start || '',
      end: b.end || '',
      time: periodTime(b),
      duration: periodDuration(b.start, b.end),
      type: 'break',
      label: b.label || b.name || 'BREAK',
      startSort: b.start || '',
    }));
    const merged = [...classes, ...breaks].sort((a, b) => {
      if (!a.startSort || !b.startSort) return 0;
      return a.startSort.localeCompare(b.startSort);
    });
    return merged.map(({ startSort, ...rest }) => rest);
  }

  return DEFAULT_PERIODS.map((p) => ({
    id: p.id,
    name: p.name,
    start: p.start || '',
    end: p.end || '',
    time: periodTime(p),
    duration: periodDuration(p.start, p.end),
    type: p.type,
    label: p.label || p.name,
  }));
}

/* ============================================================
   Image fetch (per cold start cache)
   ============================================================ */

const logoCache = new Map();

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

  doc.font(FONT_BOLD).fontSize(nameSize).fillColor(HEADER_BLUE)
    .text((school.name || FALLBACK_NAME).toUpperCase(), textX, y + 1, {
      width: Math.max(80, textW), align: 'left', ellipsis: true,
    });
  let cy = y + nameSize + 3;

  doc.font(FONT_REGULAR).fontSize(contactSize).fillColor(HEADER_CONTACT_GRAY);
  const contactLines = [];
  if (school.address) contactLines.push(String(school.address));
  if (school.phone)   contactLines.push(`Tel: ${school.phone}`);
  if (school.email)   contactLines.push(`Email: ${school.email}`);
  if (school.website) contactLines.push(`Website: ${school.website}`);

  for (const line of contactLines) {
    doc.text(line, textX, cy, {
      width: Math.max(80, textW), align: 'left', ellipsis: true, lineBreak: false,
    });
    cy += contactSize + lineGap;
  }

  if (school.motto) {
    doc.font(FONT_ITALIC).fontSize(mottoSize).fillColor(HEADER_MOTTO_GRAY)
      .text(`Motto: ${school.motto}`, textX, cy, {
        width: Math.max(80, textW), align: 'left', ellipsis: true,
      });
    cy += mottoSize + lineGap;
  }

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

/**
 * Draw the shared header row for a period-rows grid:
 *   [Period / Time] [Mon] [Tue] [Wed] [Thu] [Fri]
 * Returns the y-coordinate immediately after the header row.
 */
function drawGridHeader(doc, { x, y, w, timeColW, headerH }) {
  const dayColW = (w - timeColW) / DAYS.length;

  doc.rect(x, y, w, headerH).fill(COLORS.navy);
  doc.font(FONT_BOLD).fontSize(8.5).fillColor(COLORS.white)
    .text('Period / Time', x + 4, y + headerH / 2 - 5,
      { width: timeColW - 8, align: 'left' });

  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = x + timeColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + headerH / 2 - 5,
      { width: dayColW, align: 'center' });
  }

  return { dayColW, nextY: y + headerH };
}

/**
 * Draw the left-hand time cell for a period row: period name, time range
 * and duration in minutes.
 */
function drawTimeCell(doc, { x, y, w, h, period }) {
  doc.rect(x, y, w, h).fill(COLORS.light);
  doc.strokeColor(COLORS.border).lineWidth(0.5)
    .rect(x, y, w, h).stroke();

  const name = period.name || 'Period';
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.slate)
    .text(name, x + 4, y + 4, { width: w - 8, align: 'left', ellipsis: true });

  if (period.time) {
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
      .text(period.time, x + 4, y + 15, { width: w - 8, align: 'left' });
  }

  if (period.duration) {
    doc.font(FONT_REGULAR).fontSize(6).fillColor(COLORS.gray)
      .text(`${period.duration} min`, x + 4, y + 24, { width: w - 8, align: 'left' });
  }
}

/**
 * Draw a break row that spans all day columns.
 */
function drawBreakRow(doc, { x, y, w, h, period }) {
  doc.rect(x, y, w, h).fill(COLORS.breakBg);
  doc.strokeColor(COLORS.border).lineWidth(0.5)
    .rect(x, y, w, h).stroke();

  const label = period.label || period.name || 'BREAK';
  const timePart = period.time ? `  (${period.time})` : '';
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.breakFg)
    .text(
      `${label}${timePart}`,
      x, y + (h - 8) / 2,
      { width: w, align: 'center', characterSpacing: 1 }
    );
}

/**
 * Compute a row height so all periods fit into the available space.
 * Breaks get a fixed, shorter height.
 */
function computeRowHeights(periods, availableH, headerH, breakRowH = 16, minClassH = 22) {
  const breakCount = periods.filter((p) => p.type === 'break').length;
  const classCount = periods.length - breakCount;
  const totalBreakH = breakCount * breakRowH;
  const classRowH = Math.max(
    minClassH,
    (availableH - headerH - totalBreakH) / Math.max(1, classCount)
  );
  return { classRowH, breakRowH };
}

/* ============================================================
   Class timetable — periods as rows, days as columns
   ============================================================ */

function drawClassTimetable(doc, school, logoImg, schedule, className, term, year, periods) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Class Master Timetable',
    subtitle: `${className || ''} · ${term} ${year}`,
  });

  const gridW = pageW - MARGIN * 2;
  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const timeColW = 110;
  const headerH = 22;
  const { classRowH, breakRowH } = computeRowHeights(periods, availableH, headerH);

  const { dayColW, nextY } = drawGridHeader(doc, {
    x: MARGIN, y: startY, w: gridW, timeColW, headerH,
  });
  let y = nextY;

  for (const period of periods) {
    if (period.type === 'break') {
      drawBreakRow(doc, { x: MARGIN, y, w: gridW, h: breakRowH, period });
      y += breakRowH;
      continue;
    }

    // Time cell (left)
    drawTimeCell(doc, { x: MARGIN, y, w: timeColW, h: classRowH, period });

    // Day cells
    for (let d = 0; d < DAYS.length; d += 1) {
      const day = DAYS[d];
      const cx = MARGIN + timeColW + dayColW * d;
      const slot = schedule?.[day]?.[period.id];

      doc.rect(cx, y, dayColW, classRowH)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke();

      if (!slot) continue;

      const isEvent = !!slot.isEvent;
      if (isEvent) {
        doc.save();
        doc.rect(cx + 0.5, y + 0.5, dayColW - 1, classRowH - 1)
          .fill('#fffbea').restore();
        doc.strokeColor(COLORS.border).lineWidth(0.5)
          .rect(cx, y, dayColW, classRowH).stroke();
        doc.save();
        doc.rect(cx, y, 3, classRowH).fill(slot.eventColor || COLORS.gold).restore();
      }

      doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.slate)
        .text(slot.subject || '', cx + 4, y + 4,
          { width: dayColW - 8, align: 'left', ellipsis: true });
      doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.navyMid)
        .text(slot.teacherInitials || 'TBA', cx + 4, y + 15,
          { width: dayColW - 8, align: 'left' });
      if (slot.room) {
        doc.font(FONT_REGULAR).fontSize(6).fillColor(COLORS.gray)
          .text(slot.room, cx + 4, y + 25,
            { width: dayColW - 8, align: 'left', ellipsis: true });
      }
    }

    y += classRowH;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Teacher timetable — periods as rows, days as columns
   ============================================================ */

function drawTeacherTimetable(doc, school, logoImg, teacher, assignments, term, year, periods) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Teacher Timetable',
    subtitle: `${teacher.fullName || ''} (${teacher.initials || ''}) · ${term} ${year}`,
  });

  const gridW = pageW - MARGIN * 2;
  const footerTop = doc.page.height - FOOTER_H;
  const availableH = footerTop - startY - 8;

  const timeColW = 110;
  const headerH = 22;

  // Teacher view: only show class periods — breaks collapse out.
  const rows = periods.filter((p) => p.type !== 'break');
  const rowH = Math.max(22, (availableH - headerH) / Math.max(1, rows.length));

  const { dayColW, nextY } = drawGridHeader(doc, {
    x: MARGIN, y: startY, w: gridW, timeColW, headerH,
  });
  let y = nextY;

  for (const period of rows) {
    drawTimeCell(doc, { x: MARGIN, y, w: timeColW, h: rowH, period });

    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[i];
      const cx = MARGIN + timeColW + dayColW * i;
      const slot = assignments.find(
        (a) => a.day === day && a.period && a.period.id === period.id
      );

      doc.rect(cx, y, dayColW, rowH)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke();

      if (!slot) continue;

      doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.navy)
        .text(slot.subject || '', cx + 4, y + 5,
          { width: dayColW - 8, align: 'left', ellipsis: true });
      doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
        .text(slot.className || '', cx + 4, y + 16,
          { width: dayColW - 8, align: 'left' });
    }

    y += rowH;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Master overview — per class: periods as rows, days as columns
   ============================================================ */

function drawMasterByLevel(doc, school, logoImg, levelLabel, classes, schedules, term, year, periods) {
  const pageW = doc.page.width;
  const gridW = pageW - MARGIN * 2;
  const title = 'Master Timetable Overview';
  const subtitle = `${levelLabel} · ${term} ${year}`;

  let y = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: gridW,
    school, logoImg,
    title, subtitle,
  });

  const footerTop = doc.page.height - FOOTER_H;

  const timeColW = 90;
  const headerH = 16;
  const rowH = 16;
  const breakRowH = 12;

  // Master view: only class periods.
  const classRows = periods.filter((p) => p.type !== 'break');

  const ensureSpace = (needed) => {
    if (y + needed > footerTop) {
      doc.addPage();
      y = drawLetterheadHeader(doc, {
        x: MARGIN, y: MARGIN, w: gridW,
        school, logoImg,
        title, subtitle,
      });
    }
  };

  for (const cls of classes) {
    const schedule = schedules[cls] || {};

    // Strip with the class name
    const stripH = 16;
    ensureSpace(stripH + headerH + 40);

    doc.rect(MARGIN, y, gridW, stripH).fill(COLORS.navy);
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(COLORS.white)
      .text(String(cls).toUpperCase(), MARGIN + 6, y + 4,
        { width: gridW - 12, align: 'left' });
    y += stripH;

    // Column headers (one per class block)
    const { dayColW, nextY } = drawGridHeader(doc, {
      x: MARGIN, y, w: gridW, timeColW, headerH,
    });
    y = nextY;

    // Period rows
    for (const period of classRows) {
      ensureSpace(rowH);

      drawTimeCell(doc, {
        x: MARGIN, y, w: timeColW, h: rowH,
        period: {
          ...period,
          name: period.name.replace('Period ', 'P'),
          duration: null, // keep master density low
        },
      });

      for (let i = 0; i < DAYS.length; i += 1) {
        const day = DAYS[i];
        const cx = MARGIN + timeColW + dayColW * i;
        const slot = schedule?.[day]?.[period.id];

        doc.rect(cx, y, dayColW, rowH)
          .strokeColor(COLORS.border).lineWidth(0.4).stroke();

        if (!slot) continue;

        doc.font(FONT_BOLD).fontSize(6).fillColor(COLORS.slate)
          .text(slot.subject || '', cx + 2, y + 2,
            { width: dayColW - 4, align: 'center', ellipsis: true });
        doc.font(FONT_BOLD).fontSize(6).fillColor(COLORS.navyMid)
          .text(slot.teacherInitials || '', cx + 2, y + 9,
            { width: dayColW - 4, align: 'center' });
      }

      y += rowH;
    }

    y += 8;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Duty roster — days as columns, duty areas as rows
   (unchanged from the previous layout, which already matched
   the new convention)
   ============================================================ */

function drawDutyRoster(doc, school, logoImg, roster, term, year, dutyAreas) {
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
  const rowH = Math.max(20, (availableH - headerH) / Math.max(1, dutyAreas.length));

  let y = startY;
  doc.rect(MARGIN, y, pageW - MARGIN * 2, headerH).fill(COLORS.navy);
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.white)
    .text('Duty Area / Time', MARGIN + 4, y + 6, { width: areaColW, align: 'left' });
  for (let i = 0; i < DAYS.length; i += 1) {
    const cx = MARGIN + areaColW + dayColW * i;
    doc.text(DAYS[i].toUpperCase(), cx, y + 6, { width: dayColW, align: 'center' });
  }
  y += headerH;

  for (const area of dutyAreas) {
    doc.rect(MARGIN, y, areaColW, rowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(MARGIN, y, areaColW, rowH).stroke();
    doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.slate)
      .text(area.label, MARGIN + 4, y + 5, { width: areaColW - 8, align: 'left' });
    doc.font(FONT_REGULAR).fontSize(6.5).fillColor(COLORS.gray)
      .text(dutyTime(area), MARGIN + 4, y + 14, { width: areaColW - 8, align: 'left' });

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
  try {
    return await handle(event);
  } catch (err) {
    console.error('[timetable-pdf] FATAL:', err && err.stack ? err.stack : err);
    return json(500, {
      error: 'Function crashed: ' + (err && err.message ? err.message : String(err)),
    });
  }
};

async function handle(event) {
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

  const periods = normalizePeriods(payload);
  const dutyAreas = Array.isArray(payload.dutyAreas) && payload.dutyAreas.length
    ? payload.dutyAreas
    : DEFAULT_DUTY_AREAS;
  const levelDisplay = payload.levelDisplay && typeof payload.levelDisplay === 'object'
    ? { ...DEFAULT_LEVEL_DISPLAY, ...payload.levelDisplay }
    : DEFAULT_LEVEL_DISPLAY;

  const sectionCount =
    type === 'class'     ? 1
    : type === 'teacher' ? 1
    : type === 'duty'    ? 1
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

  const resolvedLogoUrl = logoUrl || school.logoUrl || school.schoolLogo || school.logo || '';
  const logoBuffer = await fetchImageBuffer(resolvedLogoUrl);

  console.log('[timetable-pdf] render', {
    type,
    hasLogoUrl: !!resolvedLogoUrl,
    logoBytes: logoBuffer ? logoBuffer.length : 0,
    periods: periods.length,
    breaks: periods.filter((p) => p.type === 'break').length,
    dutyAreas: dutyAreas.length,
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

  doc.font(FONT_REGULAR);

  let logoImg = null;
  if (logoBuffer) {
    try { logoImg = doc.openImage(logoBuffer); }
    catch (e) { console.warn('[timetable-pdf] openImage failed for logo:', e.message); }
  }

  try {
    switch (type) {
      case 'class': {
        doc.addPage({ layout: 'landscape' });
        drawClassTimetable(
          doc, school, logoImg,
          payload.schedule || {},
          payload.className || '',
          term, year,
          periods
        );
        break;
      }

      case 'teacher': {
        doc.addPage({ layout: 'landscape' });
        drawTeacherTimetable(
          doc, school, logoImg,
          payload.teacher || {},
          Array.isArray(payload.assignments) ? payload.assignments : [],
          term, year,
          periods
        );
        break;
      }

      case 'master': {
        const level = payload.level || '';
        const levelLabel = payload.levelLabel || levelDisplay[level] || level;
        const classes = Array.isArray(payload.classes) ? payload.classes : [];
        const schedules = payload.schedules && typeof payload.schedules === 'object'
          ? payload.schedules
          : {};
        doc.addPage({ layout: 'landscape' });
        drawMasterByLevel(
          doc, school, logoImg,
          levelLabel, classes, schedules,
          term, year, periods
        );
        break;
      }

      case 'duty': {
        doc.addPage({ layout: 'landscape' });
        drawDutyRoster(
          doc, school, logoImg,
          payload.roster || {},
          term, year,
          dutyAreas
        );
        break;
      }
    }

    doc.end();
  } catch (err) {
    console.error('[timetable-pdf] render failed:', err);
    try { doc.end(); } catch {}
    return json(500, { error: 'PDF render failed: ' + err.message });
  }

  let pdfBuffer;
  try {
    pdfBuffer = await done;
  } catch (err) {
    console.error('[timetable-pdf] stream failed:', err);
    return json(500, { error: 'PDF stream failed: ' + err.message });
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        `inline; filename="timetable-${type}-${Date.now()}.pdf"`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
    body: pdfBuffer.toString('base64'),
    isBase64Encoded: true,
  };
}
