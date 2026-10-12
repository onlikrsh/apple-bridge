// Date helpers for the Calendar app, all in local time. Plain functions so
// they can be unit-tested in Node.

export const DAY = 86400000;

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function addMonths(d, n) {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 0 = Sunday ... 6 = Saturday, from the locale (Sunday when unknown). */
export function firstDayOfWeek(locale) {
  try {
    const loc = new Intl.Locale(locale);
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch {
    // fall through
  }
  return 0;
}

export function startOfWeek(d, firstDay = 0) {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() - firstDay + 7) % 7));
}

/** The 6 (or 5) weeks the month grid shows, as arrays of 7 dates. */
export function monthWeeks(d, firstDay = 0) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  let cursor = startOfWeek(first, firstDay);
  const weeks = [];
  do {
    const week = [];
    for (let i = 0; i < 7; i += 1) week.push(addDays(cursor, i));
    weeks.push(week);
    cursor = addDays(cursor, 7);
  } while (cursor.getMonth() === d.getMonth() && weeks.length < 6);
  return weeks;
}

/** 'YYYY-MM-DD' in local time. */
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'HH:MM' for <input type=time>. */
export function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function withTime(day, time) {
  const [h, m] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0);
}

/** An occurrence's start and end as local Dates (all-day ends are exclusive). */
export function span(ev) {
  if (ev.allDay) return { start: parseYmd(ev.start), end: parseYmd(ev.end) };
  return { start: new Date(ev.start), end: new Date(ev.end) };
}

/** Does the event touch the local day `day`? */
export function onDay(ev, day) {
  const { start, end } = span(ev);
  const s = startOfDay(day);
  const e = addDays(s, 1);
  if (ev.allDay) return start < e && end > s;
  return start < e && (end > s || (end.getTime() === start.getTime() && start >= s));
}

/**
 * Side-by-side layout for overlapping timed events in one day column:
 * each gets {col, cols} so it can take 1/cols of the width.
 */
export function layoutColumns(events) {
  const sorted = [...events].sort((a, b) => a._s - b._s || b._e - a._e);
  const out = new Map();
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const colsEnd = [];
    for (const ev of cluster) {
      let col = colsEnd.findIndex((end) => end <= ev._s);
      if (col === -1) {
        col = colsEnd.length;
        colsEnd.push(ev._e);
      } else colsEnd[col] = ev._e;
      out.set(ev, { col, cols: 0 });
    }
    for (const ev of cluster) out.get(ev).cols = colsEnd.length;
    cluster = [];
  };
  for (const ev of sorted) {
    if (ev._s >= clusterEnd && cluster.length) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev._e);
  }
  if (cluster.length) flush();
  return out;
}

/** Lanes for bars that span days (all-day / multi-day), one week at a time. */
export function layoutLanes(bars) {
  const lanes = [];
  const out = new Map();
  for (const bar of [...bars].sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from))) {
    let lane = lanes.findIndex((end) => end < bar.from);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(bar.to);
    } else lanes[lane] = bar.to;
    out.set(bar, lane);
  }
  return { lanes: lanes.length, laneOf: out };
}

const RRULE_LABELS = {
  DAILY: 'Every Day',
  WEEKLY: 'Every Week',
  MONTHLY: 'Every Month',
  YEARLY: 'Every Year',
};

/** The repeat menu value for an rrule ('' none, 'custom' for what the menu can't show). */
export function repeatValue(rrule) {
  if (!rrule) return '';
  if (rrule.custom || rrule.count || rrule.until) return 'custom';
  if (rrule.freq === 'WEEKLY' && rrule.interval === 2) return 'BIWEEKLY';
  if (rrule.interval === 1 && RRULE_LABELS[rrule.freq]) return rrule.freq;
  return 'custom';
}

export function rruleFor(value) {
  if (!value) return null;
  if (value === 'BIWEEKLY') return { freq: 'WEEKLY', interval: 2 };
  return { freq: value, interval: 1 };
}
