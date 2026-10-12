// Calendar: Day / Week / Month / Year, like Calendar on macOS.

import '../shared/mac.css';
import './calendar.css';
import { h, clear, icon, tool, trafficLights, initWindow, popover, menu, closeOverlay, alert, toast, syncBadge, resizable } from '../shared/ui.js';
import {
  DAY, startOfDay, addDays, addMonths, sameDay, firstDayOfWeek, startOfWeek, monthWeeks, ymd, parseYmd, hhmm, withTime, span, onDay,
  layoutColumns, layoutLanes, repeatValue, rruleFor,
} from './dates.js';

const HOUR = 48; // px per hour in Day and Week views
const SNAP = 15; // minutes
const FIRST_DAY = firstDayOfWeek(navigator.language);
const VIEWS = ['day', 'week', 'month', 'year'];

const state = {
  view: localStorage.getItem('view') || 'week',
  date: startOfDay(new Date()),
  calendars: [],
  hidden: new Set(JSON.parse(localStorage.getItem('hidden') || '[]')),
  events: [],
  range: null,
  selected: null, // event key
  configured: true,
  mini: startOfDay(new Date()),
};
const els = {};
const fmt = {
  hour: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }),
  time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
  weekdayShort: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
  weekdayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
  monthLong: new Intl.DateTimeFormat(undefined, { month: 'long' }),
  monthShort: new Intl.DateTimeFormat(undefined, { month: 'short' }),
  dayMonth: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }),
  full: new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
};
const timeLabel = (d) => fmt.time.format(d).replace(':00', '');

// ------------------------------------------------------------------ layout

function layout() {
  const root = document.getElementById('root');
  els.calList = h('div', { class: 'sidebar-scroll' });
  els.mini = h('div', { class: 'mini' });
  els.sidebar = h(
    'aside',
    { class: 'sidebar cal-sidebar' },
    h('div', { class: 'toolbar' }, trafficLights(), h('div', { class: 'spacer' }), tool('PanelLeft', 'Hide calendar list', toggleSidebar)),
    els.calList,
    h('div', { class: 'sidebar-footer' }, els.mini),
  );
  resizable(els.sidebar, 'cal-sidebar', { min: 180, max: 300 });

  els.segmented = h('div', { class: 'segmented' }, VIEWS.map((v) => h('button', { dataset: { view: v }, onclick: () => setView(v) }, v[0].toUpperCase() + v.slice(1))));
  els.searchInput = h('input', { type: 'search', placeholder: 'Search', oninput: (e) => search(e.target.value), onkeydown: (e) => e.key === 'Escape' && endSearch() });
  els.title = h('h1', { class: 'cal-title' });
  els.body = h('div', { class: 'cal-body' });
  els.main = h(
    'main',
    { class: 'cal-main' },
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'only-collapsed' }, trafficLights()),
      tool('PanelLeft', 'Show calendar list', toggleSidebar, { class: 'only-collapsed' }),
      tool('Plus', 'New event (Ctrl+N)', () => newEventAtDefault()),
      h('div', { class: 'spacer' }),
      els.segmented,
      h('div', { class: 'spacer' }),
      syncBadge(() => window.api.calendar.sync()),
      h('label', { class: 'search' }, icon('Search'), els.searchInput),
    ),
    h(
      'div',
      { class: 'cal-header' },
      els.title,
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'nav' },
        h('button', { class: 'nav-btn', title: 'Previous', onclick: () => step(-1) }, icon('ChevronLeft')),
        h('button', { class: 'nav-btn today-btn', onclick: () => goTo(new Date()) }, 'Today'),
        h('button', { class: 'nav-btn', title: 'Next', onclick: () => step(1) }, icon('ChevronRight')),
      ),
    ),
    els.body,
  );
  root.append(els.sidebar, els.main);
  if (localStorage.getItem('cal-sidebar') === 'hidden') document.body.classList.add('no-sidebar');
}

function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
  localStorage.setItem('cal-sidebar', document.body.classList.contains('no-sidebar') ? 'hidden' : 'shown');
}

// --------------------------------------------------------------- sidebar

function renderCalendars() {
  clear(els.calList);
  els.calList.append(h('div', { class: 'section-title' }, 'iCloud'));
  for (const c of state.calendars) {
    const box = h('input', {
      type: 'checkbox',
      class: 'check',
      checked: !state.hidden.has(c.id),
      style: { '--check-color': c.color },
      onchange: (e) => {
        if (e.target.checked) state.hidden.delete(c.id);
        else state.hidden.add(c.id);
        localStorage.setItem('hidden', JSON.stringify([...state.hidden]));
        render();
      },
    });
    box.style.borderColor = c.color;
    els.calList.append(h('label', { class: 'row cal-row' }, box, h('span', { class: 'name' }, c.name)));
  }
}

function renderMini() {
  clear(els.mini);
  const m = state.mini;
  const today = new Date();
  els.mini.append(
    h(
      'div',
      { class: 'mini-head' },
      h('span', { class: 'mini-title' }, `${fmt.monthLong.format(m)} ${m.getFullYear()}`),
      h('button', { class: 'mini-nav', onclick: () => ((state.mini = addMonths(state.mini, -1)), renderMini()) }, icon('ChevronLeft')),
      h('button', { class: 'mini-nav', onclick: () => ((state.mini = addMonths(state.mini, 1)), renderMini()) }, icon('ChevronRight')),
    ),
  );
  const grid = h('div', { class: 'mini-grid' });
  const week0 = startOfWeek(new Date(), FIRST_DAY);
  for (let i = 0; i < 7; i += 1) grid.append(h('div', { class: 'mini-dow' }, fmt.weekdayShort.format(addDays(week0, i)).slice(0, 1)));
  for (const week of monthWeeks(m, FIRST_DAY)) {
    for (const d of week) {
      const cls = ['mini-day'];
      if (d.getMonth() !== m.getMonth()) cls.push('other');
      if (sameDay(d, today)) cls.push('today');
      if (sameDay(d, state.date)) cls.push('chosen');
      grid.append(h('button', { class: cls.join(' '), onclick: () => goTo(d) }, d.getDate()));
    }
  }
  els.mini.append(grid);
}

// ------------------------------------------------------------ navigation

function setView(v) {
  state.view = v;
  localStorage.setItem('view', v);
  closeOverlay();
  render();
}

function goTo(d) {
  state.date = startOfDay(d);
  state.mini = startOfDay(d);
  closeOverlay();
  render();
}

function step(dir) {
  const d = state.date;
  if (state.view === 'day') goTo(addDays(d, dir));
  else if (state.view === 'week') goTo(addDays(d, 7 * dir));
  else if (state.view === 'month') goTo(addMonths(d, dir));
  else goTo(new Date(d.getFullYear() + dir, d.getMonth(), 1));
}

function visibleRange() {
  const d = state.date;
  if (state.view === 'day') return [d, addDays(d, 1)];
  if (state.view === 'week') {
    const s = startOfWeek(d, FIRST_DAY);
    return [s, addDays(s, 7)];
  }
  if (state.view === 'month') {
    const weeks = monthWeeks(d, FIRST_DAY);
    return [weeks[0][0], addDays(weeks[weeks.length - 1][6], 1)];
  }
  return [new Date(d.getFullYear(), 0, 1), new Date(d.getFullYear() + 1, 0, 1)];
}

async function load() {
  const [start, end] = visibleRange();
  // Fetch a little either side so stepping feels instant.
  const from = addDays(start, -7);
  const to = addDays(end, 7);
  state.events = await window.api.calendar.events({ start: from.toISOString(), end: to.toISOString() });
  state.range = [from.getTime(), to.getTime()];
}

function shown(ev) {
  return !state.hidden.has(ev.calendarId);
}

async function render() {
  const [start, end] = visibleRange();
  if (!state.range || start.getTime() < state.range[0] || end.getTime() > state.range[1]) await load();
  for (const b of els.segmented.children) b.classList.toggle('on', b.dataset.view === state.view);
  renderTitle();
  renderMini();
  clear(els.body);
  els.body.className = `cal-body view-${state.view}`;
  if (!state.configured) {
    els.body.append(h('div', { class: 'empty' }, h('div', {}, h('div', { class: 'empty-title' }, 'Calendar isn’t set up yet'), h('p', {}, 'In a terminal, run ', h('code', {}, 'abridge setup calendar'), '.'))));
    return;
  }
  if (state.view === 'day' || state.view === 'week') renderTimeGrid();
  else if (state.view === 'month') renderMonth();
  else renderYear();
}

function renderTitle() {
  const d = state.date;
  clear(els.title);
  if (state.view === 'year') els.title.append(h('b', {}, d.getFullYear()));
  else if (state.view === 'day') els.title.append(h('b', {}, `${d.getDate()} ${fmt.monthLong.format(d)}`), ` ${d.getFullYear()}`, h('div', { class: 'cal-subtitle' }, fmt.weekdayLong.format(d)));
  else els.title.append(h('b', {}, fmt.monthLong.format(d)), ` ${d.getFullYear()}`);
}

// ------------------------------------------------------------ day / week

function renderTimeGrid() {
  const days = state.view === 'day' ? [state.date] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(state.date, FIRST_DAY), i));
  const today = new Date();
  const events = state.events.filter(shown);

  // Column headers.
  const head = h('div', { class: 'tg-head', style: { '--cols': days.length } }, h('div', { class: 'tg-gutter' }));
  for (const d of days) {
    head.append(
      h(
        'div',
        { class: `tg-day ${sameDay(d, today) ? 'today' : ''} ${[0, 6].includes(d.getDay()) ? 'weekend' : ''}`, ondblclick: () => goTo(d) || setView('day') },
        h('span', { class: 'dow' }, state.view === 'day' ? fmt.weekdayLong.format(d) : fmt.weekdayShort.format(d)),
        h('span', { class: 'dnum' }, d.getDate()),
      ),
    );
  }

  // All-day row: bars spanning the days they cover.
  const allDay = h('div', { class: 'tg-allday', style: { '--cols': days.length } }, h('div', { class: 'tg-gutter allday-label' }, 'all-day'));
  const lanesHost = h('div', { class: 'allday-lanes' });
  allDay.append(lanesHost);
  const first = days[0];
  const bars = [];
  for (const ev of events) {
    const { start, end } = span(ev);
    const multi = ev.allDay || end - start >= DAY;
    if (!multi) continue;
    const from = Math.max(0, Math.round((startOfDay(start) - first) / DAY));
    const lastDay = ev.allDay ? addDays(end, -1) : end;
    const to = Math.min(days.length - 1, Math.round((startOfDay(lastDay) - first) / DAY));
    if (to < 0 || from > days.length - 1 || to < from) continue;
    bars.push({ ev, from, to });
  }
  const { lanes, laneOf } = layoutLanes(bars);
  lanesHost.style.height = `${Math.max(1, lanes) * 22 + 4}px`;
  for (const bar of bars) {
    lanesHost.append(
      eventEl(bar.ev, 'bar', {
        left: `calc(${(bar.from / days.length) * 100}% + 2px)`,
        width: `calc(${((bar.to - bar.from + 1) / days.length) * 100}% - 4px)`,
        top: `${laneOf.get(bar) * 22 + 2}px`,
      }),
    );
  }
  lanesHost.addEventListener('dblclick', (e) => {
    if (e.target !== lanesHost) return;
    const col = Math.floor(((e.clientX - lanesHost.getBoundingClientRect().left) / lanesHost.clientWidth) * days.length);
    createEvent({ allDay: true, start: days[col], end: addDays(days[col], 1) }, e);
  });

  // The hour grid.
  const scroller = h('div', { class: 'tg-scroll' });
  const grid = h('div', { class: 'tg-grid', style: { '--cols': days.length, height: `${24 * HOUR}px` } });
  const gutter = h('div', { class: 'tg-gutter hours' });
  for (let hr = 1; hr < 24; hr += 1) {
    const label = hr === 12 ? 'Noon' : fmt.hour.format(new Date(2000, 0, 1, hr)).replace(/\s/g, ' ');
    gutter.append(h('div', { class: 'hour-label', style: { top: `${hr * HOUR}px` } }, label));
  }
  grid.append(gutter);
  days.forEach((d, i) => {
    const col = h('div', { class: `tg-col ${[0, 6].includes(d.getDay()) ? 'weekend' : ''}`, dataset: { index: i } });
    attachGridCreate(col, d);
    const dayEvents = events
      .filter((ev) => {
        const { start, end } = span(ev);
        return !ev.allDay && end - start < DAY && onDay(ev, d);
      })
      .map((ev) => {
        const { start, end } = span(ev);
        const s0 = startOfDay(d).getTime();
        const top = Math.max(0, (start - s0) / 60000);
        const bottom = Math.min(24 * 60, (end - s0) / 60000);
        return Object.assign(Object.create(ev), { _s: top, _e: Math.max(bottom, top + 20) });
      });
    const cols = layoutColumns(dayEvents);
    for (const pe of dayEvents) {
      const { col: c, cols: n } = cols.get(pe);
      const el = eventEl(Object.getPrototypeOf(pe), 'block', {
        top: `${(pe._s / 60) * HOUR}px`,
        height: `${Math.max(((pe._e - pe._s) / 60) * HOUR - 2, 18)}px`,
        left: `calc(${(c / n) * 100}% + 1px)`,
        width: `calc(${100 / n}% - 3px)`,
      });
      col.append(el);
    }
    if (sameDay(d, today)) {
      const mins = today.getHours() * 60 + today.getMinutes();
      col.append(h('div', { class: 'now-line', style: { top: `${(mins / 60) * HOUR}px` } }));
      gutter.append(h('div', { class: 'now-label', style: { top: `${(mins / 60) * HOUR}px` } }, timeLabel(today)));
      // Like macOS: the hour label under the red time label steps aside.
      gutter.querySelectorAll('.hour-label').forEach((l) => {
        if (Math.abs(parseFloat(l.style.top) - (mins / 60) * HOUR) < HOUR * 0.3) l.style.visibility = 'hidden';
      });
    }
    grid.append(col);
  });
  scroller.append(grid);
  els.body.append(head, allDay, scroller);
  // Re-rendering after an edit keeps the scroll position; navigating to
  // another day or week starts near now (or 8 AM).
  const gridKey = `${state.view}:${ymd(days[0])}`;
  const now = new Date();
  const focusHour = days.some((d) => sameDay(d, now)) ? Math.max(0, now.getHours() - 2) : 8;
  const top = state.gridKey === gridKey && state.gridScroll !== undefined ? state.gridScroll : focusHour * HOUR;
  state.gridKey = gridKey;
  scroller.scrollTop = top;
  requestAnimationFrame(() => (scroller.scrollTop = top));
  scroller.addEventListener('scroll', () => (state.gridScroll = scroller.scrollTop));
}

/** Drag on empty grid space to make an event; double-click makes a one-hour one. */
function attachGridCreate(col, day) {
  const minutesAt = (e) => {
    const y = e.clientY - col.getBoundingClientRect().top;
    return Math.max(0, Math.min(24 * 60, Math.round((y / HOUR) * 60 / SNAP) * SNAP));
  };
  col.addEventListener('pointerdown', (e) => {
    if (e.target !== col || e.button !== 0) return;
    const startMin = Math.floor(minutesAt(e) / 30) * 30;
    let endMin = startMin;
    let ghost = null;
    const move = (ev) => {
      endMin = Math.max(minutesAt(ev), startMin + SNAP);
      if (!ghost && endMin - startMin >= 30) {
        ghost = h('div', { class: 'event block ghost' });
        col.append(ghost);
      }
      if (ghost) Object.assign(ghost.style, { top: `${(startMin / 60) * HOUR}px`, height: `${((endMin - startMin) / 60) * HOUR}px`, left: '1px', width: 'calc(100% - 3px)' });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!ghost) return;
      ghost.remove();
      const s = new Date(startOfDay(day).getTime() + startMin * 60000);
      createEvent({ allDay: false, start: s, end: new Date(startOfDay(day).getTime() + endMin * 60000) }, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  col.addEventListener('dblclick', (e) => {
    if (e.target !== col) return;
    const startMin = Math.floor(minutesAt(e) / 30) * 30;
    const s = new Date(startOfDay(day).getTime() + startMin * 60000);
    createEvent({ allDay: false, start: s, end: new Date(s.getTime() + 3600000) }, e);
  });
}

// ------------------------------------------------------------------ month

function renderMonth() {
  const weeks = monthWeeks(state.date, FIRST_DAY);
  const today = new Date();
  const events = state.events.filter(shown);
  const head = h('div', { class: 'month-head' });
  for (const d of weeks[0]) head.append(h('div', { class: 'month-dow' }, fmt.weekdayShort.format(d)));
  const grid = h('div', { class: 'month', style: { '--weeks': weeks.length } });
  for (const week of weeks) {
    const row = h('div', { class: 'month-week' });
    const bars = [];
    for (const ev of events) {
      const { start, end } = span(ev);
      if (!(ev.allDay || end - start >= DAY)) continue;
      const lastDay = ev.allDay ? addDays(end, -1) : end;
      const from = Math.max(0, Math.round((startOfDay(start) - week[0]) / DAY));
      const to = Math.min(6, Math.round((startOfDay(lastDay) - week[0]) / DAY));
      if (to < 0 || from > 6 || to < from) continue;
      bars.push({ ev, from, to });
    }
    const { lanes, laneOf } = layoutLanes(bars);
    const shownLanes = Math.min(lanes, 3);
    week.forEach((d, i) => {
      const cls = ['month-cell'];
      if (d.getMonth() !== state.date.getMonth()) cls.push('other');
      if ([0, 6].includes(d.getDay())) cls.push('weekend');
      if (sameDay(d, today)) cls.push('today');
      const label = d.getDate() === 1 ? `${fmt.monthShort.format(d)} 1` : String(d.getDate());
      const cell = h('div', { class: cls.join(' '), ondblclick: (e) => e.target.closest('.event') || createEvent({ allDay: true, start: d, end: addDays(d, 1) }, e) }, h('div', { class: 'month-num' }, h('span', {}, label)));
      cell.append(h('div', { style: { height: `${shownLanes * 19}px`, flex: 'none' } }));
      const timed = events.filter((ev) => {
        const { start, end } = span(ev);
        return !ev.allDay && end - start < DAY && onDay(ev, d) && sameDay(start, d);
      });
      const hiddenBars = bars.filter((b) => laneOf.get(b) >= 3 && b.from <= i && b.to >= i).length;
      const room = Math.max(0, 4 - shownLanes);
      const list = h('div', { class: 'month-events' });
      timed.slice(0, room).forEach((ev) => list.append(eventEl(ev, 'line')));
      const more = timed.length - Math.min(timed.length, room) + hiddenBars;
      if (more > 0) list.append(h('div', { class: 'more', onclick: () => (goTo(d), setView('day')) }, `${more} more…`));
      cell.append(list);
      row.append(cell);
    });
    for (const bar of bars) {
      const lane = laneOf.get(bar);
      if (lane >= 3) continue;
      row.append(eventEl(bar.ev, 'bar', { left: `calc(${(bar.from / 7) * 100}% + 3px)`, width: `calc(${((bar.to - bar.from + 1) / 7) * 100}% - 6px)`, top: `${26 + lane * 19}px` }));
    }
    grid.append(row);
  }
  els.body.append(head, grid);
}

// ------------------------------------------------------------------- year

function renderYear() {
  const y = state.date.getFullYear();
  const today = new Date();
  const busy = new Set();
  for (const ev of state.events.filter(shown)) {
    const { start, end } = span(ev);
    for (let d = startOfDay(start); d < end || sameDay(d, start); d = addDays(d, 1)) {
      busy.add(ymd(d));
      if (busy.size > 5000) break;
    }
  }
  const grid = h('div', { class: 'year' });
  for (let m = 0; m < 12; m += 1) {
    const first = new Date(y, m, 1);
    const month = h('div', { class: 'year-month' }, h('div', { class: `year-name ${today.getFullYear() === y && today.getMonth() === m ? 'current' : ''}`, onclick: () => (goTo(first), setView('month')) }, fmt.monthLong.format(first)));
    const g = h('div', { class: 'year-grid' });
    for (let i = 0; i < 7; i += 1) g.append(h('div', { class: 'year-dow' }, fmt.weekdayShort.format(addDays(startOfWeek(first, FIRST_DAY), i)).slice(0, 1)));
    for (const week of monthWeeks(first, FIRST_DAY)) {
      for (const d of week) {
        const cls = ['year-day'];
        if (d.getMonth() !== m) cls.push('other');
        else if (busy.has(ymd(d))) cls.push('busy');
        if (sameDay(d, today) && d.getMonth() === m) cls.push('today');
        g.append(h('button', { class: cls.join(' '), onclick: () => d.getMonth() === m && (goTo(d), setView('day')) }, d.getMonth() === m ? d.getDate() : ''));
      }
    }
    month.append(g);
    grid.append(month);
  }
  els.body.append(grid);
}

// ----------------------------------------------------------------- events

function eventEl(ev, kind, style = {}) {
  const { start } = span(ev);
  const el = h('div', {
    class: `event ${kind} ${ev.allDay ? 'allday' : ''} ${state.selected === ev.key ? 'selected' : ''}`,
    style: { '--c': ev.color, ...style },
    title: ev.title,
    dataset: { key: ev.key },
  });
  if (kind === 'line') {
    el.append(h('span', { class: 'dot' }), h('span', { class: 'ev-title' }, ev.title), h('span', { class: 'ev-time' }, timeLabel(start)));
  } else if (kind === 'bar') {
    el.append(h('span', { class: 'ev-title' }, ev.title));
  } else {
    el.append(h('div', { class: 'ev-title' }, ev.title), h('div', { class: 'ev-time' }, ev.location ? `${timeLabel(start)} · ${ev.location}` : timeLabel(start)));
    el.append(h('div', { class: 'resize' }));
  }
  if (ev.recurring) el.classList.add('recurring');
  attachEventPointer(el, ev, kind);
  return el;
}

/** Click to inspect; in Day/Week, drag to move and drag the bottom edge to resize. */
function attachEventPointer(el, ev, kind) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const resizing = e.target.classList.contains('resize');
    const draggable = kind === 'block';
    const startX = e.clientX;
    const startY = e.clientY;
    const { start, end } = span(ev);
    const col = el.parentElement;
    const grid = col && col.parentElement;
    const colWidth = col ? col.getBoundingClientRect().width : 1;
    let moved = false;
    let deltaMin = 0;
    let deltaDays = 0;
    const move = (m) => {
      if (!draggable) return;
      const dx = m.clientX - startX;
      const dy = m.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      el.classList.add('dragging');
      deltaMin = Math.round(((dy / HOUR) * 60) / SNAP) * SNAP;
      if (resizing) {
        const minEnd = 15 - (end - start) / 60000;
        deltaMin = Math.max(deltaMin, minEnd);
        el.style.height = `${(((end - start) / 60000 + deltaMin) / 60) * HOUR - 2}px`;
      } else {
        deltaDays = state.view === 'week' ? Math.round(dx / colWidth) : 0;
        const index = Number(col.dataset.index) + deltaDays;
        if (index < 0 || index >= grid.querySelectorAll('.tg-col').length) deltaDays = 0;
        el.style.transform = `translate(${deltaDays * colWidth}px, ${(deltaMin / 60) * HOUR}px)`;
      }
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        openInspector(ev, el);
        return;
      }
      if (!deltaMin && !deltaDays) {
        render();
        return;
      }
      const shift = deltaDays * DAY + deltaMin * 60000;
      const newStart = resizing ? start : new Date(start.getTime() + shift);
      const newEnd = resizing ? new Date(end.getTime() + deltaMin * 60000) : new Date(end.getTime() + shift);
      await saveEvent({ ...ev, start: newStart.toISOString(), end: newEnd.toISOString() }, { askSeries: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function select(key) {
  state.selected = key;
  document.querySelectorAll('.event.selected').forEach((n) => n.classList.remove('selected'));
  if (key) document.querySelectorAll(`.event[data-key="${CSS.escape(key)}"]`).forEach((n) => n.classList.add('selected'));
}

async function saveEvent(ev, { askSeries = false } = {}) {
  if (askSeries && ev.recurring && !ev.exception) {
    const ok = await alert({
      title: 'Change all events in this series?',
      message: 'This is a repeating event. Changes from Linux apply to every occurrence.',
      buttons: [
        { label: 'Change All', value: true, primary: true },
        { label: 'Cancel', value: false, cancel: true },
      ],
    });
    if (!ok) {
      render();
      return null;
    }
  }
  try {
    const saved = await window.api.calendar.save(ev);
    state.range = null;
    await render();
    return saved;
  } catch (err) {
    toast(cleanError(err), { error: true });
    render();
    return null;
  }
}

async function deleteEvent(ev) {
  let scope = 'all';
  if (ev.recurring) {
    scope = await alert({
      title: `Delete “${ev.title}”?`,
      message: 'This is a repeating event.',
      buttons: [
        { label: 'Delete This Event Only', value: 'one', primary: true },
        { label: 'Delete All Events', value: 'all', destructive: true },
        { label: 'Cancel', value: null, cancel: true },
      ],
    });
    if (!scope) return;
  }
  closeOverlay();
  try {
    await window.api.calendar.remove({ calendarId: ev.calendarId, file: ev.file, scope, recurrenceId: ev.recurrenceId });
    state.selected = null;
    state.range = null;
    render();
  } catch (err) {
    toast(cleanError(err), { error: true });
  }
}

function defaultCalendar() {
  const saved = localStorage.getItem('default-calendar');
  const visible = state.calendars.filter((c) => !state.hidden.has(c.id));
  return visible.find((c) => c.id === saved) || visible.find((c) => /home|calendar/i.test(c.name)) || visible[0] || state.calendars[0];
}

/** A new, unsaved event; it's written when its inspector closes. */
function createEvent({ allDay, start, end }, e) {
  const cal = defaultCalendar();
  if (!cal) return;
  const ev = {
    key: `new-${Date.now()}`,
    isNew: true,
    calendarId: cal.id,
    color: cal.color,
    title: '',
    location: '',
    notes: '',
    url: '',
    allDay,
    start: allDay ? ymd(start) : start.toISOString(),
    end: allDay ? ymd(end) : end.toISOString(),
    recurring: false,
    rrule: null,
    alarm: null,
  };
  const anchor = e && e.clientX !== undefined ? new DOMRect(e.clientX, e.clientY, 1, 1) : els.body.getBoundingClientRect();
  openInspector(ev, anchor);
}

function newEventAtDefault() {
  const base = state.view === 'month' || state.view === 'year' ? state.date : state.date;
  const now = new Date();
  const hour = sameDay(base, now) ? now.getHours() + 1 : 9;
  const s = withTime(base, `${hour}:00`);
  createEvent({ allDay: false, start: s, end: new Date(s.getTime() + 3600000) }, null);
}

// -------------------------------------------------------------- inspector

const REPEATS = [
  ['', 'None'],
  ['DAILY', 'Every Day'],
  ['WEEKLY', 'Every Week'],
  ['BIWEEKLY', 'Every 2 Weeks'],
  ['MONTHLY', 'Every Month'],
  ['YEARLY', 'Every Year'],
];
const ALERTS = [
  ['', 'None'],
  ['0', 'At time of event'],
  ['5', '5 minutes before'],
  ['10', '10 minutes before'],
  ['15', '15 minutes before'],
  ['30', '30 minutes before'],
  ['60', '1 hour before'],
  ['120', '2 hours before'],
  ['1440', '1 day before'],
  ['2880', '2 days before'],
];

function select_(options, value, extra) {
  const s = h('select', { class: 'field' });
  for (const [v, label] of options) s.append(h('option', { value: v, selected: v === value }, label));
  if (extra && !options.some(([v]) => v === value)) s.append(h('option', { value, selected: true, disabled: true }, extra));
  return s;
}

function openInspector(ev, anchor) {
  select(ev.key);
  const { start, end } = span(ev);
  const cal = state.calendars.find((c) => c.id === ev.calendarId) || { name: '?', color: ev.color };
  let calendarId = ev.calendarId;
  const shownEnd = ev.allDay ? addDays(end, -1) : end;

  const title = h('input', { class: 'insp-title', value: ev.title, placeholder: 'New Event' });
  const location = h('input', { class: 'insp-plain', value: ev.location, placeholder: 'Add Location' });
  const allDay = h('input', { type: 'checkbox', class: 'check', checked: ev.allDay });
  const sDate = h('input', { type: 'date', class: 'field', value: ymd(start) });
  const sTime = h('input', { type: 'time', class: 'field', value: hhmm(start), step: 300 });
  const eDate = h('input', { type: 'date', class: 'field', value: ymd(shownEnd) });
  const eTime = h('input', { type: 'time', class: 'field', value: hhmm(end), step: 300 });
  const repeatInit = repeatValue(ev.rrule);
  const repeat = select_(REPEATS, repeatInit, 'Custom');
  const alertInit = ev.alarm === null || ev.alarm === undefined ? '' : String(ev.alarm);
  const alarm = select_(ALERTS, alertInit, `${ev.alarm} minutes before`);
  const calBtn = h('button', { class: 'cal-pick' }, h('span', { class: 'swatch', style: { background: cal.color } }), h('span', {}, cal.name), icon('ChevronDown'));
  const notes = h('textarea', { class: 'insp-plain notes', rows: 2, placeholder: 'Add Notes' }, ev.notes);
  notes.value = ev.notes;
  const url = h('input', { class: 'insp-plain', value: ev.url, placeholder: 'Add URL' });
  const toggleTimes = () => {
    sTime.hidden = allDay.checked;
    eTime.hidden = allDay.checked;
  };
  allDay.addEventListener('change', toggleTimes);
  toggleTimes();
  calBtn.addEventListener('click', () =>
    menu(
      calBtn,
      state.calendars.map((c) => ({
        label: c.name,
        swatch: c.color,
        checked: c.id === calendarId,
        onClick: () => {
          calendarId = c.id;
          clear(calBtn).append(h('span', { class: 'swatch', style: { background: c.color } }), h('span', {}, c.name), icon('ChevronDown'));
        },
      })),
    ),
  );

  const row = (label, ...control) => h('div', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), h('div', { class: 'insp-control' }, ...control));
  const body = h(
    'div',
    { class: 'inspector' },
    title,
    location,
    h('div', { class: 'insp-sep' }),
    row('all-day:', allDay),
    row('starts:', sDate, sTime),
    row('ends:', eDate, eTime),
    row('repeat:', repeat),
    row('alert:', alarm),
    h('div', { class: 'insp-sep' }),
    row('calendar:', calBtn),
    h('div', { class: 'insp-sep' }),
    notes,
    url,
    h('div', { class: 'insp-actions' }, ev.isNew ? h('button', { class: 'btn', onclick: () => ((discard = true), closeOverlay()) }, 'Discard') : h('button', { class: 'btn destructive', onclick: () => ((discard = true), deleteEvent(ev)) }, 'Delete Event')),
  );

  let discard = false;
  const collect = () => {
    const isAllDay = allDay.checked;
    let s;
    let en;
    if (isAllDay) {
      s = ymd(parseYmd(sDate.value));
      en = ymd(addDays(parseYmd(eDate.value < sDate.value ? sDate.value : eDate.value), 1));
    } else {
      const sd = withTime(parseYmd(sDate.value), sTime.value || '09:00');
      let ed = withTime(parseYmd(eDate.value), eTime.value || '10:00');
      if (ed <= sd) ed = new Date(sd.getTime() + 3600000);
      s = sd.toISOString();
      en = ed.toISOString();
    }
    const out = {
      ...ev,
      title: title.value.trim() || 'New Event',
      location: location.value,
      notes: notes.value,
      url: url.value,
      allDay: isAllDay,
      start: s,
      end: en,
      toCalendarId: calendarId !== ev.calendarId ? calendarId : undefined,
    };
    if (repeat.value !== repeatInit) out.rrule = rruleFor(repeat.value);
    else delete out.rrule; // unchanged: leave the file's rule exactly as it is
    out.alarm = alarm.value === alertInit ? undefined : alarm.value === '' ? null : Number(alarm.value);
    return out;
  };
  const changed = (out) =>
    ev.isNew ||
    out.title !== (ev.title || 'New Event') ||
    out.location !== ev.location ||
    out.notes !== ev.notes ||
    out.url !== ev.url ||
    out.allDay !== ev.allDay ||
    out.start !== ev.start ||
    out.end !== ev.end ||
    out.toCalendarId ||
    out.rrule !== undefined ||
    out.alarm !== undefined;

  popover(anchor, body, {
    side: 'right',
    width: 300,
    onClose: async () => {
      select(null);
      if (discard) return;
      const out = collect();
      if (!changed(out)) return;
      if (ev.isNew) {
        localStorage.setItem('default-calendar', out.toCalendarId || out.calendarId);
        if (out.toCalendarId) {
          out.calendarId = out.toCalendarId;
          delete out.toCalendarId;
        }
        delete out.key;
      }
      const timesMoved = out.start !== ev.start || out.end !== ev.end;
      await saveEvent(out, { askSeries: !ev.isNew && timesMoved });
    },
  });
  if (ev.isNew) title.focus();
  title.addEventListener('keydown', (e) => e.key === 'Enter' && closeOverlay());
}

// ------------------------------------------------------------------ search

let searchPool = null;
let searchBox = null;

async function search(q) {
  q = q.trim().toLowerCase();
  if (searchBox) searchBox.remove();
  if (!q) return;
  if (!searchPool) {
    const now = new Date();
    searchPool = await window.api.calendar.events({ start: addDays(now, -365).toISOString(), end: addDays(now, 365).toISOString() });
  }
  const hits = searchPool.filter((ev) => `${ev.title}\n${ev.location}\n${ev.notes}`.toLowerCase().includes(q)).slice(0, 40);
  const field = els.searchInput.closest('.search').getBoundingClientRect();
  searchBox = h('div', { class: 'menu search-results', style: { left: `${field.right - 320}px`, top: `${field.bottom + 6}px`, width: '320px' } });
  if (!hits.length) searchBox.append(h('div', { class: 'menu-item disabled' }, 'No Results'));
  for (const ev of hits) {
    const { start } = span(ev);
    searchBox.append(
      h(
        'div',
        {
          class: 'menu-item result',
          onclick: () => {
            endSearch();
            goTo(start);
            if (state.view === 'year') setView('week');
            setTimeout(() => select(ev.key), 50);
          },
        },
        h('span', { class: 'swatch', style: { background: ev.color } }),
        h('span', { class: 'r-title' }, ev.title),
        h('span', { class: 'shortcut' }, ev.allDay ? fmt.dayMonth.format(start) : `${fmt.dayMonth.format(start)}, ${timeLabel(start)}`),
      ),
    );
  }
  document.body.append(searchBox);
}

function endSearch() {
  els.searchInput.value = '';
  searchPool = null;
  if (searchBox) searchBox.remove();
  searchBox = null;
}

// ------------------------------------------------------------------- keys

function keys(e) {
  if (e.target.closest('input, textarea, select, .popover')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey) {
    const view = { 1: 'day', 2: 'week', 3: 'month', 4: 'year' }[e.key];
    if (view) return e.preventDefault(), setView(view);
    if (k === 't') return e.preventDefault(), goTo(new Date());
    if (k === 'n') return e.preventDefault(), newEventAtDefault();
    if (k === 'f') return e.preventDefault(), els.searchInput.focus();
    if (k === 'r') return e.preventDefault(), window.api.calendar.sync();
    if (k === 'arrowleft') return e.preventDefault(), step(-1);
    if (k === 'arrowright') return e.preventDefault(), step(1);
  }
  if ((k === 'delete' || k === 'backspace') && state.selected) {
    const ev = state.events.find((x) => x.key === state.selected);
    if (ev) deleteEvent(ev);
  }
}

function cleanError(err) {
  return String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------------------------- boot

async function refreshCalendars() {
  const { configured, calendars } = await window.api.calendar.calendars();
  state.configured = configured;
  state.calendars = calendars;
  renderCalendars();
}

async function boot() {
  layout();
  initWindow();
  document.addEventListener('keydown', keys);
  window.api.calendar.onChanged(async () => {
    await refreshCalendars();
    state.range = null;
    if (!document.querySelector('.popover')) render();
  });
  await refreshCalendars();
  await render();
  window.__abridge = { state, render }; // for the end-to-end tests
  // Keep the red "now" line moving.
  setInterval(() => {
    if ((state.view === 'day' || state.view === 'week') && !document.querySelector('.popover, .dragging')) render();
  }, 60000);
}

boot();
