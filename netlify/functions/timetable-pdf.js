const { withCors } = require('./_lib/cors');
// netlify/functions/timetable-pdf.js
// A4 landscape timetable renderer (PDFKit).
// Supports: class | teacher | master | duty.
//
// Layout convention:
//   - Rows    = Days of the week (Monday … Friday)
//   - Columns = Periods (time shown in the header row, like a normal period)
//   - Break columns span all five day-rows as a tinted band; the break
//     label ("BREAK", "LUNCH BREAK", …) is centered vertically inside
//     that band. The header cell for a break shows only its time range,
//     matching the layout of a normal period.
//   - Duty roster keeps duty areas as rows and days as columns
//
// Footer safety:
//   Every grid is height-clamped to [startY, footerTop]. Rows are sized
//   so the last row lands exactly on footerTop, and the footer is drawn
//   once at a fixed y that always sits inside the A4 printable area.

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

const MARGIN = 28;
const HEADER_LOGO = 46;
const FOOTER_H = 40;

// Minimum row heights so we never collapse to zero even with 12+ periods.
const MIN_DAY_ROW_H = 22;
const MIN_CLASS_ROW_H = 22;
const MIN_MASTER_ROW_H = 16;

/* ============================================================
   Defaults
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
   Image fetch
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

/**
 * Draw the footer at a fixed y — always inside the printable area.
 * Callers must have already clamped the grid so it ends above footerTop.
 */
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
   Grid layout helpers
   ============================================================ */

/**
 * Compute the available height for a grid: from startY down to the top
 * of the footer, minus a small gutter so text never touches the footer rule.
 */
function gridAvailableHeight(doc, startY, gutter = 6) {
  const footerTop = doc.page.height - FOOTER_H;
  return Math.max(0, footerTop - startY - gutter);
}

/**
 * Given a desired row height and the number of rows to draw, clamp the
 * row height so all rows fit inside availableH. Returns the final rowH.
 */
function clampRowHeight(desiredH, rowCount, availableH, minH) {
  if (rowCount <= 0) return minH;
  const maxFit = availableH / rowCount;
  // Never shrink below minH — if maxFit is smaller, the caller should
  // handle overflow another way (e.g. reduce periods per page).
  return Math.max(minH, Math.min(desiredH, maxFit));
}

function layoutColumns({ x, totalW, dayColW, periods, breakColW = 26 }) {
  const classCount = periods.filter((p) => p.type !== 'break').length;
  const breakCount = periods.length - classCount;

  const classColW = classCount > 0
    ? (totalW - dayColW - breakColW * breakCount) / classCount
    : 0;

  const columns = [];
  let cx = x + dayColW;
  for (const period of periods) {
    const w = period.type === 'break' ? breakColW : classColW;
    columns.push({ period, x: cx, w });
    cx += w;
  }
  return columns;
}

function drawPeriodHeaderRow(doc, { x, y, w, dayColW, columns, headerH }) {
  doc.rect(x, y, w, headerH).fill(COLORS.navy);

  doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.white)
    .text('Day / Time', x + 4, y + headerH / 2 - 5,
      { width: dayColW - 8, align: 'left' });

  doc.save();
  doc.moveTo(x + dayColW, y).lineTo(x + dayColW, y + headerH)
    .lineWidth(0.5).strokeColor('#2b3a72').stroke();
  doc.restore();

  for (const { period, x: cx, w: colW } of columns) {
    doc.save();
    doc.moveTo(cx, y).lineTo(cx, y + headerH)
      .lineWidth(0.5).strokeColor('#2b3a72').stroke();
    doc.restore();

    if (period.type === 'break') {
      doc.save();
      doc.rect(cx + 0.5, y + 0.5, colW - 1, headerH - 1)
        .fill('#1c2652').restore();
    }

    if (period.type !== 'break') {
      doc.font(FONT_BOLD).fontSize(6.5).fillColor(COLORS.white)
        .text(period.name || 'Period', cx + 2, y + 4,
          { width: colW - 4, align: 'center', ellipsis: true });
    }

    if (period.time) {
      doc.font(FONT_REGULAR).fontSize(5.5)
        .fillColor(period.type === 'break' ? '#e6bf55' : '#c7d0ea')
        .text(period.time, cx + 2, y + 13,
          { width: colW - 4, align: 'center', ellipsis: true });
    }
  }

  doc.save();
  doc.moveTo(x + w, y).lineTo(x + w, y + headerH)
    .lineWidth(0.5).strokeColor('#2b3a72').stroke();
  doc.restore();

  return y + headerH;
}

function drawBreakBands(doc, { columns, rowsTop, rowsBottom }) {
  const totalH = rowsBottom - rowsTop;
  if (totalH <= 0) return;

  for (const { period, x: cx, w: colW } of columns) {
    if (period.type !== 'break') continue;

    doc.save();
    doc.rect(cx + 0.3, rowsTop + 0.3, colW - 0.6, totalH - 0.6)
      .fill(COLORS.breakBg).restore();

    doc.save();
    doc.moveTo(cx, rowsTop).lineTo(cx, rowsBottom)
      .lineWidth(0.5).strokeColor(COLORS.border).stroke();
    doc.moveTo(cx + colW, rowsTop).lineTo(cx + colW, rowsBottom)
      .lineWidth(0.5).strokeColor(COLORS.border).stroke();
    doc.restore();

    const label = (period.label || period.name || 'BREAK').toUpperCase();
    doc.save();
    // Font size scaled to available height so long labels stay legible
    // without overflowing the band.
    const fontSize = Math.max(5.5, Math.min(7, totalH / 22));
    doc.font(FONT_BOLD).fontSize(fontSize).fillColor(COLORS.breakFg);
    const cxMid = cx + colW / 2;
    const cyMid = rowsTop + totalH / 2;
    doc.rotate(-90, { origin: [cxMid, cyMid] });
    doc.text(label, cxMid - totalH / 2, cyMid - 4, {
      width: totalH,
      align: 'center',
      lineBreak: false,
    });
    doc.restore();
  }
}

function drawDayRow(doc, {
  x, y, w, h, day, dayColW, columns, schedule,
}) {
  doc.rect(x, y, dayColW, h).fill(COLORS.light);
  doc.strokeColor(COLORS.border).lineWidth(0.5)
    .rect(x, y, dayColW, h).stroke();
  doc.font(FONT_BOLD).fontSize(8.5).fillColor(COLORS.slate)
    .text(day, x + 4, y + h / 2 - 6, { width: dayColW - 8, align: 'left' });

  for (const { period, x: cx, w: colW } of columns) {
    if (period.type === 'break') continue;

    doc.rect(cx, y, colW, h).strokeColor(COLORS.border).lineWidth(0.5).stroke();

    const slot = schedule?.[day]?.[period.id];
    if (!slot) continue;

    const isEvent = !!slot.isEvent;
    if (isEvent) {
      doc.save();
      doc.rect(cx + 0.4, y + 0.4, colW - 0.8, h - 0.8).fill('#fffbea').restore();
      doc.save();
      doc.rect(cx, y, 3, h).fill(slot.eventColor || COLORS.gold).restore();
    }

    doc.font(FONT_BOLD).fontSize(6.5).fillColor(COLORS.slate)
      .text(slot.subject || '', cx + 3, y + 3,
        { width: colW - 6, align: 'left', ellipsis: true });
    doc.font(FONT_BOLD).fontSize(6.5).fillColor(COLORS.navyMid)
      .text(slot.teacherInitials || 'TBA', cx + 3, y + h - 14,
        { width: colW - 6, align: 'left', ellipsis: true });
    if (slot.room && h > 40) {
      doc.font(FONT_REGULAR).fontSize(5.5).fillColor(COLORS.gray)
        .text(slot.room, cx + 3, y + h - 22,
          { width: colW - 6, align: 'left', ellipsis: true });
    }
  }
}

/* ============================================================
   Class timetable — days as rows, periods as columns
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
  const headerH = 26;
  const dayColW = 90;

  // Compute the exact vertical space the grid can occupy.
  const availableH = gridAvailableHeight(doc, startY, 6);
  const gridBodyH = Math.max(0, availableH - headerH);

  // Clamp the day-row height so all five rows land exactly above the footer.
  const dayRowH = clampRowHeight(
    Number.POSITIVE_INFINITY, // we want to fill the space
    DAYS.length,
    gridBodyH,
    MIN_DAY_ROW_H
  );

  const columns = layoutColumns({
    x: MARGIN, totalW: gridW, dayColW, periods, breakColW: 26,
  });

  const headerBottom = drawPeriodHeaderRow(doc, {
    x: MARGIN, y: startY, w: gridW, dayColW, columns, headerH,
  });
  let y = headerBottom;

  for (const day of DAYS) {
    drawDayRow(doc, {
      x: MARGIN, y, w: gridW, h: dayRowH,
      day, dayColW, columns, schedule,
    });
    y += dayRowH;
  }

  drawBreakBands(doc, {
    columns,
    rowsTop: headerBottom,
    rowsBottom: headerBottom + dayRowH * DAYS.length,
  });

  drawFooter(doc, school);
}

/* ============================================================
   Teacher timetable — days as rows, periods as columns
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
  const headerH = 26;
  const dayColW = 90;

  const availableH = gridAvailableHeight(doc, startY, 6);
  const gridBodyH = Math.max(0, availableH - headerH);

  const dayRowH = clampRowHeight(
    Number.POSITIVE_INFINITY,
    DAYS.length,
    gridBodyH,
    MIN_DAY_ROW_H
  );

  const columns = layoutColumns({
    x: MARGIN, totalW: gridW, dayColW, periods, breakColW: 26,
  });

  const headerBottom = drawPeriodHeaderRow(doc, {
    x: MARGIN, y: startY, w: gridW, dayColW, columns, headerH,
  });
  let y = headerBottom;

  for (const day of DAYS) {
    doc.rect(MARGIN, y, dayColW, dayRowH).fill(COLORS.light);
    doc.strokeColor(COLORS.border).lineWidth(0.5)
      .rect(MARGIN, y, dayColW, dayRowH).stroke();
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(COLORS.slate)
      .text(day, MARGIN + 4, y + dayRowH / 2 - 6,
        { width: dayColW - 8, align: 'left' });

    for (const { period, x: cx, w: colW } of columns) {
      if (period.type === 'break') continue;

      doc.rect(cx, y, colW, dayRowH)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke();

      const slot = assignments.find(
        (a) => a.day === day && a.period && a.period.id === period.id
      );
      if (!slot) continue;

      doc.font(FONT_BOLD).fontSize(6.5).fillColor(COLORS.navy)
        .text(slot.subject || '', cx + 3, y + 4,
          { width: colW - 6, align: 'left', ellipsis: true });
      doc.font(FONT_REGULAR).fontSize(6).fillColor(COLORS.gray)
        .text(slot.className || '', cx + 3, y + dayRowH - 13,
          { width: colW - 6, align: 'left', ellipsis: true });
    }

    y += dayRowH;
  }

  drawBreakBands(doc, {
    columns,
    rowsTop: headerBottom,
    rowsBottom: headerBottom + dayRowH * DAYS.length,
  });

  drawFooter(doc, school);
}

/* ============================================================
   Master overview — one block per class, days as rows
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

  const dayColW = 60;
  const headerH = 22;
  const dayRowH = 22;

  // Block height = strip + header + 5 day rows + gutter
  const blockH = 14 + headerH + dayRowH * DAYS.length + 8;

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

    // If a whole block can't fit on the current page, start a new page.
    if (y + blockH > footerTop && y > MARGIN + HEADER_LOGO + 40) {
      doc.addPage();
      y = drawLetterheadHeader(doc, {
        x: MARGIN, y: MARGIN, w: gridW,
        school, logoImg,
        title, subtitle,
      });
    }

    // Class name strip
    const stripH = 14;
    doc.rect(MARGIN, y, gridW, stripH).fill(COLORS.navy);
    doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.white)
      .text(String(cls).toUpperCase(), MARGIN + 6, y + 3,
        { width: gridW - 12, align: 'left' });
    y += stripH;

    const columns = layoutColumns({
      x: MARGIN, totalW: gridW, dayColW, periods, breakColW: 18,
    });

    const headerBottom = drawPeriodHeaderRow(doc, {
      x: MARGIN, y, w: gridW, dayColW, columns, headerH,
    });
    y = headerBottom;

    // Day rows — bounded by dayRowH * 5, which fits because we checked
    // blockH above before starting this class block.
    for (const day of DAYS) {
      doc.rect(MARGIN, y, dayColW, dayRowH).fill(COLORS.light);
      doc.strokeColor(COLORS.border).lineWidth(0.4)
        .rect(MARGIN, y, dayColW, dayRowH).stroke();
      doc.font(FONT_BOLD).fontSize(6.5).fillColor(COLORS.slate)
        .text(day.slice(0, 3).toUpperCase(), MARGIN + 4, y + dayRowH / 2 - 4,
          { width: dayColW - 8, align: 'left' });

      for (const { period, x: cx, w: colW } of columns) {
        if (period.type === 'break') continue;

        doc.rect(cx, y, colW, dayRowH)
          .strokeColor(COLORS.border).lineWidth(0.4).stroke();

        const slot = schedule?.[day]?.[period.id];
        if (!slot) continue;

        doc.font(FONT_BOLD).fontSize(5.5).fillColor(COLORS.slate)
          .text(slot.subject || '', cx + 2, y + 2,
            { width: colW - 4, align: 'center', ellipsis: true });
        doc.font(FONT_BOLD).fontSize(5.5).fillColor(COLORS.navyMid)
          .text(slot.teacherInitials || '', cx + 2, y + 11,
            { width: colW - 4, align: 'center' });
      }

      y += dayRowH;
    }

    drawBreakBands(doc, {
      columns,
      rowsTop: headerBottom,
      rowsBottom: headerBottom + dayRowH * DAYS.length,
    });

    y += 8;
  }

  drawFooter(doc, school);
}

/* ============================================================
   Duty roster — duty areas as rows, days as columns
   ============================================================ */

function drawDutyRoster(doc, school, logoImg, roster, term, year, dutyAreas) {
  const pageW = doc.page.width;
  const startY = drawLetterheadHeader(doc, {
    x: MARGIN, y: MARGIN, w: pageW - MARGIN * 2,
    school, logoImg,
    title: 'Weekly Duty Roster',
    subtitle: `${term} ${year}`,
  });

  const gridW = pageW - MARGIN * 2;
  const headerH = 22;
  const areaColW = 150;
  const dayColW = (gridW - areaColW) / DAYS.length;

  const availableH = gridAvailableHeight(doc, startY, 6);
  const gridBodyH = Math.max(0, availableH - headerH);

  // Clamp duty-area row heights so they fit above the footer.
  const rowH = clampRowHeight(
    Number.POSITIVE_INFINITY,
    dutyAreas.length,
    gridBodyH,
    MIN_DAY_ROW_H
  );

  let y = startY;
  doc.rect(MARGIN, y, gridW, headerH).fill(COLORS.navy);
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

exports.handler = withCors(exports.handler);
