// Reminders logic with no DOM: due dates, smart lists and grouping, so the
// rules can be unit-tested in Node.
//
// Due dates follow Apple's storage: an all-day reminder is 00:00 UTC on the
// literal date (never shifted by your time zone); a timed one is an instant.

export const SMART = [
  { id: 'today', label: 'Today', color: '#007AFF', icon: 'CalendarDays' },
  { id: 'scheduled', label: 'Scheduled', color: '#FF3B30', icon: 'Calendar' },
  { id: 'all', label: 'All', color: '#5B5B60', icon: 'Inbox' },
  { id: 'flagged', label: 'Flagged', color: '#FF9500', icon: 'Flag' },
  { id: 'completed', label: 'Completed', color: '#8E8E93', icon: 'Check' },
];

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar day a reminder is due on, as 'YYYY-MM-DD' (or null). */
export function dueDay(r) {
  if (!r.due) return null;
  if (r.all_day) return r.due.slice(0, 10);
  const d = new Date(r.due);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isOverdue(r, now = new Date()) {
  if (!r.due || r.completed) return false;
  if (r.all_day) return dueDay(r) < todayKey(now);
  return new Date(r.due) < now;
}

export function isToday(r, now = new Date()) {
  return !!r.due && dueDay(r) === todayKey(now);
}

function dayLabel(key, now) {
  const today = todayKey(now);
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (key === today) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const opts = diff > 1 && diff < 7 ? { weekday: 'long' } : { weekday: 'short', day: 'numeric', month: 'short', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return date.toLocaleDateString(undefined, opts);
}

/** "Today, 11:00", "Tomorrow", "Mon, 19 Oct"... as Reminders shows it. */
export function dueText(r, now = new Date()) {
  if (!r.due) return '';
  const label = dayLabel(dueDay(r), now);
  if (r.all_day) return label;
  return `${label}, ${new Date(r.due).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function priorityMarks(p) {
  return { 1: '!!!', 5: '!!', 9: '!' }[p] || '';
}

export function priorityName(p) {
  return { 1: 'high', 5: 'medium', 9: 'low' }[p] || 'none';
}

function byDue(a, b) {
  const ka = a.due ? `${dueDay(a)}${a.all_day ? 'T00' : new Date(a.due).toISOString()}` : '9999';
  const kb = b.due ? `${dueDay(b)}${b.all_day ? 'T00' : new Date(b.due).toISOString()}` : '9999';
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function byCreated(a, b) {
  return (a.created || '').localeCompare(b.created || '');
}

/** Parents first, each followed by its subtasks. */
export function withSubtasks(items) {
  const ids = new Set(items.map((r) => r.id));
  const top = items.filter((r) => !r.parent_id || !ids.has(r.parent_id));
  const out = [];
  for (const r of top) {
    out.push({ ...r, depth: 0 });
    for (const c of items.filter((x) => x.parent_id === r.id)) out.push({ ...c, depth: 1 });
  }
  return out;
}

export function counts(data, now = new Date()) {
  const open = data.reminders.filter((r) => !r.completed);
  return {
    today: open.filter((r) => isToday(r, now) || isOverdue(r, now)).length,
    scheduled: open.filter((r) => r.due).length,
    all: open.length,
    flagged: open.filter((r) => r.flagged).length,
    completed: data.reminders.filter((r) => r.completed).length,
  };
}

/**
 * The sections a view shows: [{ title, color?, listId?, items }].
 * `view` is a smart list id or a list id.
 */
export function sections(data, view, { showCompleted = false, query = '', now = new Date() } = {}) {
  const q = query.trim().toLowerCase();
  const listOf = new Map(data.lists.map((l) => [l.id, l]));
  let pool = data.reminders;
  if (q) pool = pool.filter((r) => `${r.title}\n${r.notes}`.toLowerCase().includes(q));
  const keep = (r) => showCompleted || !r.completed;
  const byList = (items) =>
    data.lists
      .map((l) => ({ title: l.title, color: l.color, listId: l.id, items: withSubtasks(items.filter((r) => r.list_id === l.id).sort(byCreated)) }))
      .filter((s) => s.items.length);

  if (q) return byList(pool.filter(keep));
  if (view === 'today') {
    const overdue = pool.filter((r) => isOverdue(r, now) && !isToday(r, now)).sort(byDue);
    const today = pool.filter((r) => isToday(r, now) && keep(r)).sort(byDue);
    return [
      ...(overdue.length ? [{ title: 'Overdue', items: overdue }] : []),
      ...(today.length || !overdue.length ? [{ title: 'Today', items: today }] : []),
    ];
  }
  if (view === 'scheduled') {
    const groups = new Map();
    for (const r of pool.filter((x) => x.due && keep(x)).sort(byDue)) {
      const label = isOverdue(r, now) && !isToday(r, now) ? 'Overdue' : dayLabel(dueDay(r), now);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    return [...groups].map(([title, items]) => ({ title, items }));
  }
  if (view === 'all') return byList(pool.filter(keep));
  if (view === 'flagged') return byList(pool.filter((r) => r.flagged && keep(r)));
  if (view === 'completed') return byList(pool.filter((r) => r.completed));
  const list = listOf.get(view);
  if (!list) return [];
  return [{ title: null, color: list.color, listId: list.id, items: withSubtasks(pool.filter((r) => r.list_id === view && keep(r)).sort(byCreated)) }];
}

/** The due argument for `abridge rem`: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'. */
export function dueArg(day, time) {
  if (!day) return null;
  return time ? `${day} ${time}` : day;
}
