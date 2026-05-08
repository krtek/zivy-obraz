import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createCanvas } from 'canvas';
import axios from 'axios';
import { createBakalariClient } from './utils/bakalari.mjs';
import { describeRelativeDay, startOfUtcDay } from './utils/util.mjs';

const { values, positionals } = parseArgs({
  options: {
    'bakalari-base-url': { type: 'string' },
    'bakalari-username': { type: 'string' },
    'bakalari-password': { type: 'string' },
    'golemio-token': { type: 'string' },
    'stop-id-1': { type: 'string' },
    'stop-id-2': { type: 'string' },
    output: { type: 'string' }
  },
  allowPositionals: true
});

function resolveValue(name, index) {
  return values[name] ?? positionals[index];
}

const bakalariBaseUrl = resolveValue('bakalari-base-url', 0);
const bakalariUsername = resolveValue('bakalari-username', 1);
const bakalariPassword = resolveValue('bakalari-password', 2);
const golemioToken = resolveValue('golemio-token', 3);
const stopId1 = resolveValue('stop-id-1', 4);
const stopId2 = resolveValue('stop-id-2', 5);
const outputPath = values['output'] ?? 'dashboard.png';

if (!bakalariBaseUrl || !bakalariUsername || !bakalariPassword) {
  throw new Error(
    'Usage: node src/dashboard-sync.mjs --bakalari-base-url=URL --bakalari-username=USER --bakalari-password=PASS [--golemio-token=TOKEN --stop-id-1=STOPID1 --stop-id-2=STOPID2] [--output=dashboard.png]'
  );
}

const now = new Date();
const timezone = 'Europe/Prague';

const { fetchTimetableForDay, fetchHomeworks } = createBakalariClient({
  baseUrl: bakalariBaseUrl,
  username: bakalariUsername,
  password: bakalariPassword
});

// ── resolve target day (same logic as timetable-sync) ───────────────────────
function resolveTargetDay(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    weekday: 'short',
    hour12: false
  }).formatToParts(now);

  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const base = startOfUtcDay(now);

  if (weekday === 'Sat' || weekday === 'Sun') {
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + (weekday === 'Sat' ? 2 : 1));
    return next;
  }

  if (hour < 16) return base;

  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextWeekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(next);
  if (nextWeekday === 'Sat') next.setUTCDate(next.getUTCDate() + 2);
  else if (nextWeekday === 'Sun') next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// ── fetch marks (inline, same pattern as marks-sync) ────────────────────────
async function fetchLatestMarks() {
  const baseUrl = bakalariBaseUrl.trim().replace(/\/$/, '');
  const fromDate = new Date(now);
  fromDate.setMonth(fromDate.getMonth() - 1);

  const body = new URLSearchParams({
    client_id: 'ANDR',
    grant_type: 'password',
    username: bakalariUsername,
    password: bakalariPassword
  });

  const loginRes = await axios.post(`${baseUrl}/api/login`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  if (!loginRes.data?.access_token) throw new Error('Bakaláři login failed.');

  const token = loginRes.data.access_token;
  const res = await axios.get(`${baseUrl}/api/3/marks`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { from: fromDate.toISOString().split('T')[0], to: now.toISOString().split('T')[0] }
  });

  const subjects = res.data?.Subjects ?? res.data?.subjects ?? [];

  return subjects
    .flatMap(subject => {
      const subjectName = subject?.Subject?.Abbrev?.trim() ?? subject?.Subject?.Name ?? '?';
      return (subject?.Marks ?? subject?.marks ?? []).map(mark => ({
        date: new Date(mark.MarkDate ?? mark.Date ?? mark.Created),
        subjectName,
        grade: mark.MarkText ?? mark.Text ?? mark.Caption ?? '',
        caption: mark.Caption ?? mark.Theme ?? ''
      }));
    })
    .filter(m => m.grade && !isNaN(m.date.getTime()))
    .sort((a, b) => b.date - a.date)
    .slice(0, 6);
}

// ── fetch departures from Golemio ────────────────────────────────────────────
async function fetchDepartures(stopId) {
  if (!golemioToken || !stopId) return [];

  const url = `https://api.golemio.cz/v2/pid/departureboards?ids=${encodeURIComponent(stopId)}&total=3&preferredTimezone=Europe%2FPrague&minutesBefore=-9`;
  const res = await axios.get(url, {
    headers: { accept: 'application/json; charset=utf-8', 'x-access-token': golemioToken.trim() }
  });

  return (res.data?.departures ?? []).map(d => {
    const scheduledIso = d.departure_timestamp?.scheduled ?? '';
    const scheduledTime = scheduledIso ? scheduledIso.slice(11, 16) : '';
    const delayMinutes = d.delay?.minutes ?? 0;
    const predictedIso = d.departure_timestamp?.predicted ?? '';
    const predictedTime = delayMinutes >= 1 && predictedIso ? predictedIso.slice(11, 16) : null;
    return {
      routeShortName: d.route?.short_name ?? '',
      headsign: d.trip?.headsign ?? '',
      scheduledTime,
      predictedTime,
      delayMinutes,
      isCanceled: d.trip?.is_canceled ?? false
    };
  });
}

function formatMarkDate(date) {
  return new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', timeZone: timezone })
    .format(date)
    .replace(/\s/g, '');
}

// ── render (e-ink optimised — high contrast, thick strokes) ─────────────────
const W = 480;
const H = 800;
const PAD = 20;

// Colors — e-ink safe: true black, white, red. No grays below #444.
const BLACK = '#000000';
const WHITE = '#ffffff';
const RED = '#bb0000';
const DARK = '#333333';   // only for non-critical secondary text; still legible on e-ink

// Typography — thick sans-serif only; hairline serifs disappear on e-ink
const FONT_WEEKDAY = 'bold 32px sans-serif';
const FONT_DATE = 'bold 16px sans-serif';
const FONT_SECTION = 'bold 13px sans-serif';
const FONT_BODY = '16px sans-serif';
const FONT_BODY_MEDIUM = 'bold 16px sans-serif';
const FONT_BODY_BOLD = 'bold 16px sans-serif';
const FONT_TIME_COL = 'bold 15px monospace';
const FONT_GRADE = 'bold 18px sans-serif';
const FONT_FOOTER = 'bold 12px sans-serif';
const FONT_EMPTY = '15px sans-serif';

function makeDateHeader(targetDay) {
  const weekday = new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', timeZone: timezone }).format(targetDay);
  const date = new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone
  }).format(targetDay);
  const capped = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return { weekday: capped, date };
}

function truncateToWidth(ctx, str, maxWidth) {
  if (ctx.measureText(str).width <= maxWidth) return str;
  let lo = 0,
    hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(str.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo) + '…';
}

function drawHairline(ctx, y, x1 = PAD, x2 = W - PAD) {
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

function drawThickRule(ctx, y, x1 = PAD, x2 = W - PAD) {
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

function drawSectionLabel(ctx, label, y) {
  // Uppercase tracked label with a red accent square
  const LABEL_Y = y + 14;
  const SQUARE_SIZE = 6;

  // Red accent square
  ctx.fillStyle = RED;
  ctx.fillRect(PAD, LABEL_Y - SQUARE_SIZE + 1, SQUARE_SIZE, SQUARE_SIZE);

  // Section label — uppercase, letter-spaced
  ctx.fillStyle = BLACK;
  ctx.font = FONT_SECTION;
  const text = label.toUpperCase();
  let x = PAD + SQUARE_SIZE + 6;
  for (const ch of text) {
    ctx.fillText(ch, x, LABEL_Y);
    x += ctx.measureText(ch).width + 1.5; // manual tracking
  }

  return y + 24;
}

async function render() {
  const targetDay = resolveTargetDay(now);
  const today = startOfUtcDay(now);
  const isShowingNextDay = targetDay.getTime() !== today.getTime();
  const fromDate = today;
  const toDate = new Date(fromDate);
  toDate.setMonth(toDate.getMonth() + 1);

  const [lessons, homeworks, marks, departuresSchool, departuresCity] = await Promise.all([
    fetchTimetableForDay(targetDay).toPromise(),
    fetchHomeworks(fromDate, toDate).toPromise(),
    fetchLatestMarks(),
    Promise.resolve([]),
    Promise.resolve([])
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  let y = 0;

  // ── masthead — always shows today ─────────────────────────────────────────
  y = 16;
  const { weekday, date } = makeDateHeader(today);

  // Single-line masthead: weekday left, date right — baseline-aligned
  const HEADER_H = 34;
  ctx.fillStyle = BLACK;
  ctx.font = FONT_WEEKDAY;
  ctx.fillText(weekday, PAD, y + HEADER_H);

  ctx.fillStyle = DARK;
  ctx.font = FONT_DATE;
  const dateW = ctx.measureText(date).width;
  ctx.fillText(date, W - PAD - dateW, y + HEADER_H);
  y += HEADER_H + 8;

  // Rule under masthead
  drawThickRule(ctx, y);
  y += 12;

  // ── timetable ──────────────────────────────────────────────────────────────
  const timetableLabel = isShowingNextDay
    ? `Rozvrh — ${new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', timeZone: timezone }).format(targetDay)}`
    : 'Rozvrh';
  y = drawSectionLabel(ctx, timetableLabel, y);
  y += 4;

  const LINE_H = 26;
  const TIME_W = 52;
  const SUBJ_X = PAD + TIME_W + 8;

  if (!Array.isArray(lessons) || lessons.length === 0) {
    ctx.fillStyle = BLACK;
    ctx.font = FONT_EMPTY;
    ctx.fillText('Dnes nejsou žádné hodiny.', PAD, y + 14);
    y += LINE_H;
  } else {
    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i];
      const rowY = y + LINE_H - 6;

      // Time column — monospace, black
      ctx.fillStyle = BLACK;
      ctx.font = FONT_TIME_COL;
      const slot = lesson.beginTime ? lesson.beginTime : `${lesson.order}.`;
      ctx.fillText(slot, PAD, rowY);

      // Subject name
      const parts = [lesson.subjectName];
      if (lesson.group && lesson.group.trim()) parts.push(lesson.group);
      let subjText = parts.join(' · ');

      if (lesson.removed) {
        ctx.fillStyle = RED;
        ctx.font = FONT_BODY;
        const fullText = subjText + ' — zrušeno';
        ctx.fillText(truncateToWidth(ctx, fullText, W - PAD - SUBJ_X), SUBJ_X, rowY);
      } else {
        ctx.fillStyle = BLACK;
        ctx.font = FONT_BODY_MEDIUM;
        ctx.fillText(truncateToWidth(ctx, subjText, W - PAD - SUBJ_X), SUBJ_X, rowY);

        // Note (substitution etc.)
        if (lesson.note) {
          ctx.fillStyle = DARK;
          ctx.font = '14px sans-serif';
          const noteText = truncateToWidth(ctx, lesson.note, W - PAD - SUBJ_X);
          ctx.fillText(noteText, SUBJ_X, rowY + 16);
          y += 16;
        }
      }

      y += LINE_H;
    }
  }

  y += 6;
  drawThickRule(ctx, y);
  y += 12;

  // ── marks ──────────────────────────────────────────────────────────────────
  y = drawSectionLabel(ctx, 'Známky', y);
  y += 4;

  if (!marks.length) {
    ctx.fillStyle = BLACK;
    ctx.font = FONT_EMPTY;
    ctx.fillText('Žádné nové známky.', PAD, y + 14);
    y += LINE_H;
  } else {
    // 2-column grid — up to 6 marks (3 rows × 2 cols)
    const COL_COUNT = 2;
    const COL_GAP = 16;
    const COL_W = Math.floor((W - PAD * 2 - COL_GAP) / 2);
    const ROW_H = 42;
    const GRADE_W = 28; // reserved width for the grade digit(s)

    for (let i = 0; i < marks.length; i++) {
      const col = i % COL_COUNT;
      const row = Math.floor(i / COL_COUNT);
      const cellX = PAD + col * (COL_W + COL_GAP);
      const cellY = y + row * ROW_H + 4;

      const m = marks[i];
      const gradeNum = parseInt(m.grade, 10);
      const isBad = gradeNum >= 4;

      // Grade — huge numeral, vertically centred
      ctx.font = 'bold 36px sans-serif';
      ctx.fillStyle = isBad ? RED : BLACK;
      const gradeStr = m.grade;
      const gradeW = ctx.measureText(gradeStr).width;
      ctx.fillText(gradeStr, cellX, cellY + 30);

      // Text column — starts after grade
      const textX = cellX + gradeW + 10;
      const textMaxW = COL_W - gradeW - 10;

      // Subject + caption — bold subject, regular caption, single line
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = BLACK;
      const subjW = ctx.measureText(m.subjectName).width;
      ctx.fillText(truncateToWidth(ctx, m.subjectName, textMaxW), textX, cellY + 18);

      ctx.font = '14px sans-serif';
      ctx.fillStyle = BLACK;
      const captionX = textX + Math.min(subjW, textMaxW) + 6;
      const captionMaxW = cellX + COL_W - captionX;
      if (captionMaxW > 10 && m.caption) {
        ctx.fillText(truncateToWidth(ctx, m.caption, captionMaxW), captionX, cellY + 18);
      }

      // Date — small, dark gray, second row
      ctx.font = '11px sans-serif';
      ctx.fillStyle = DARK;
      ctx.fillText(formatMarkDate(m.date), textX, cellY + 34);

      // Hairline below each full row (not after last row)
      const isLastRow = row === Math.floor((marks.length - 1) / COL_COUNT);
      if (!isLastRow && col === COL_COUNT - 1) {
        drawHairline(ctx, cellY + ROW_H - 2, PAD, W - PAD);
      }
    }

    const rowCount = Math.ceil(marks.length / COL_COUNT);
    y += rowCount * ROW_H;
  }

  y += 4;
  drawThickRule(ctx, y);
  y += 12;

  // ── homeworks ──────────────────────────────────────────────────────────────
  y = drawSectionLabel(ctx, 'Domácí úkoly', y);
  y += 4;

  const hwList = Array.isArray(homeworks) ? homeworks.slice(-5) : [];

  if (!hwList.length) {
    ctx.fillStyle = BLACK;
    ctx.font = FONT_EMPTY;
    ctx.fillText('Žádné nadcházející domácí úkoly.', PAD, y + 14);
    y += LINE_H;
  } else {
    for (let i = 0; i < hwList.length; i++) {
      const hw = hwList[i];
      const indicator = describeRelativeDay(now, hw.dueDate);
      const isUrgent = indicator === 'dnes' || indicator === 'zítra';
      const rowY = y + 18;

      // Deadline indicator pill
      ctx.font = 'bold 12px sans-serif';
      const tagText = indicator;
      const tagW = ctx.measureText(tagText).width + 12;
      const tagH = 18;
      const tagX = PAD;
      const tagY = rowY - 13;

      if (isUrgent) {
        ctx.fillStyle = RED;
        roundRect(ctx, tagX, tagY, tagW, tagH, 3);
        ctx.fill();
        ctx.fillStyle = WHITE;
      } else {
        ctx.strokeStyle = BLACK;
        ctx.lineWidth = 1;
        roundRect(ctx, tagX, tagY, tagW, tagH, 3);
        ctx.stroke();
        ctx.fillStyle = BLACK;
      }
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(tagText, tagX + 6, rowY);

      // Subject + content
      const contentX = tagX + tagW + 8;
      ctx.fillStyle = BLACK;
      ctx.font = FONT_BODY_BOLD;
      const subjLabel = hw.subjectName + ': ';
      ctx.fillText(subjLabel, contentX, rowY);
      const subjLabelW = ctx.measureText(subjLabel).width;

      ctx.fillStyle = BLACK;
      ctx.font = FONT_BODY;
      const content = (hw.content || 'Bez popisu').replace(/\s+/g, ' ');
      ctx.fillText(truncateToWidth(ctx, content, W - PAD - contentX - subjLabelW), contentX + subjLabelW, rowY);

      y += 28;

      if (i < hwList.length - 1) {
        drawHairline(ctx, y - 6, PAD, W - PAD);
      }
    }
  }

  // ── departures ─────────────────────────────────────────────────────────────
  const departureSets = [
    { title: 'Do Školy', departures: departuresSchool },
    { title: 'Do města', departures: departuresCity }
  ].filter(s => s.departures.length > 0);

  for (const { title, departures } of departureSets) {
    y += 4;
    drawThickRule(ctx, y);
    y += 12;

    y = drawSectionLabel(ctx, title, y);
    y += 4;

    const DEP_LINE_H = 26;
    const ROUTE_W = 36;

    for (let i = 0; i < departures.length; i++) {
      const dep = departures[i];
      const rowY = y + DEP_LINE_H - 6;

      // Route badge — bold black box
      ctx.fillStyle = BLACK;
      ctx.font = 'bold 15px sans-serif';
      const badgeText = dep.routeShortName;
      const badgeW = Math.max(ROUTE_W, ctx.measureText(badgeText).width + 12);
      ctx.fillRect(PAD, rowY - 15, badgeW, 18);
      ctx.fillStyle = WHITE;
      ctx.fillText(badgeText, PAD + (badgeW - ctx.measureText(badgeText).width) / 2, rowY);

      // Headsign — reserve space for time column on the right
      const headsignX = PAD + badgeW + 8;
      ctx.fillStyle = dep.isCanceled ? RED : BLACK;
      ctx.font = dep.isCanceled ? FONT_BODY : FONT_BODY_MEDIUM;
      // measure widest possible time string to reserve space
      ctx.font = FONT_TIME_COL;
      const timeColW = ctx.measureText('(+00) 00:00').width + 8;
      ctx.font = dep.isCanceled ? FONT_BODY : FONT_BODY_MEDIUM;
      const headsignMaxW = W - PAD - headsignX - timeColW;
      ctx.fillText(truncateToWidth(ctx, dep.headsign, headsignMaxW), headsignX, rowY);

      // Departure time — right-aligned, monospace
      ctx.font = FONT_TIME_COL;
      if (dep.isCanceled) {
        ctx.fillStyle = RED;
        const cancelW = ctx.measureText('zrušeno').width;
        ctx.fillText('zrušeno', W - PAD - cancelW, rowY);
      } else {
        const timeW = ctx.measureText(dep.scheduledTime).width;
        if (dep.predictedTime) {
          const delayStr = `(+${dep.delayMinutes})`;
          const delayW = ctx.measureText(delayStr).width;
          const scheduledW = ctx.measureText(dep.scheduledTime).width;
          const gap = 4;
          const totalW = delayW + gap + scheduledW;
          ctx.fillStyle = RED;
          ctx.fillText(delayStr, W - PAD - totalW, rowY);
          ctx.fillStyle = BLACK;
          ctx.fillText(dep.scheduledTime, W - PAD - scheduledW, rowY);
        } else {
          ctx.fillStyle = BLACK;
          ctx.fillText(dep.scheduledTime, W - PAD - timeW, rowY);
        }
      }

      y += DEP_LINE_H;
    }
  }

  // ── footer ─────────────────────────────────────────────────────────────────
  const footerY = H - 22;

  drawThickRule(ctx, footerY - 8);

  ctx.fillStyle = BLACK;
  ctx.font = FONT_FOOTER;
  const ts = new Intl.DateTimeFormat('cs-CZ', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone
  }).format(now);
  ctx.fillText(`Aktualizováno ${ts}`, PAD, footerY + 4);

  // ── save ───────────────────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  writeFileSync(outputPath, buf);
  console.log(`Dashboard saved to ${outputPath} (${W}x${H})`);
}

// Rounded rectangle helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

render().catch(err => {
  console.error('Error generating dashboard:', err);
  process.exit(1);
});
