'use strict';
// The Calendar app's store: the vdirs vdirsyncer keeps in step with iCloud.
// One directory per calendar (with `displayname` and `color` files), one
// .ics file per event. Writing a file here and running `abridge sync
// calendar` is exactly how a change reaches the iPhone.
//
// Edits preserve everything they don't touch: the file is parsed, the
// properties the inspector shows are updated, and the rest (attendees,
// travel time, Apple's X- properties) is written back as it was.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ICAL = require('ical.js');

const HIDDEN = /^Reminders\b.*⚠/; // the stub CalDAV list left behind by the Reminders upgrade
// A daily event from years ago walks thousands of dates to reach today;
// skipping them is cheap, the cap only stops a runaway rule.
const MAX_OCCURRENCES = 100000;
const PRODID = '-//apple-bridge//Calendar//EN';

function normColor(raw) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(raw || '').trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 'YYYY-MM-DD' for an all-day ICAL.Time. */
function dateString(t) {
  return `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function dateFromString(s) {
  const [year, month, day] = s.split('-').map(Number);
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

function registerZones(vcal) {
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
    } catch {
      // A broken VTIMEZONE: times in it fall back to floating.
    }
  }
}

function alarmMinutes(vevent) {
  const alarm = vevent.getFirstSubcomponent('valarm');
  const trigger = alarm && alarm.getFirstPropertyValue('trigger');
  if (!trigger || !(trigger instanceof ICAL.Duration)) return null;
  return Math.round(-trigger.toSeconds() / 60);
}

function recurData(vevent) {
  const rrule = vevent.getFirstPropertyValue('rrule');
  if (!rrule) return null;
  return {
    freq: rrule.freq,
    interval: rrule.interval || 1,
    count: rrule.count || null,
    until: rrule.until ? (rrule.until.isDate ? dateString(rrule.until) : rrule.until.toJSDate().toISOString()) : null,
    // BYDAY, BYMONTHDAY and friends: more than the Repeat menu can show or write.
    custom: Object.keys(rrule.parts || {}).length > 0,
  };
}

class CalendarStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.cache = new Map(); // file -> {mtime, vcal}
  }

  exists() {
    return fs.existsSync(this.root) && this.calendars().length > 0;
  }

  calendars() {
    let dirs;
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return dirs
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const dir = path.join(this.root, d.name);
        return { id: d.name, name: readText(path.join(dir, 'displayname')) || d.name, color: normColor(readText(path.join(dir, 'color'))) || '#1BADF8' };
      })
      .filter((c) => !HIDDEN.test(c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  dir(calendarId) {
    if (!/^[^/\\]+$/.test(calendarId) || calendarId.startsWith('.')) throw new Error('bad calendar id');
    const dir = path.join(this.root, calendarId);
    if (!fs.existsSync(dir)) throw new Error(`no calendar ${calendarId}`);
    return dir;
  }

  file(calendarId, file) {
    if (!/^[^/\\]+\.ics$/.test(file)) throw new Error('bad file name');
    return path.join(this.dir(calendarId), file);
  }

  load(full) {
    const mtime = fs.statSync(full).mtimeMs;
    const hit = this.cache.get(full);
    if (hit && hit.mtime === mtime) return hit.vcal;
    const vcal = new ICAL.Component(ICAL.parse(fs.readFileSync(full, 'utf8')));
    registerZones(vcal);
    this.cache.set(full, { mtime, vcal });
    return vcal;
  }

  /** Every occurrence overlapping [start, end), recurring events expanded. */
  events(start, end) {
    const out = [];
    const rangeStart = ICAL.Time.fromJSDate(start, true);
    for (const cal of this.calendars()) {
      const dir = path.join(this.root, cal.id);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ics')) continue;
        let vcal;
        try {
          vcal = this.load(path.join(dir, name));
        } catch {
          continue; // unparseable file: skip it, don't break the calendar
        }
        const vevents = vcal.getAllSubcomponents('vevent');
        const master = vevents.find((v) => !v.hasProperty('recurrence-id')) || vevents[0];
        if (!master) continue;
        const event = new ICAL.Event(master, { exceptions: vevents.filter((v) => v !== master && v.hasProperty('recurrence-id')) });
        const base = { calendarId: cal.id, color: cal.color, file: name, uid: event.uid };
        if (!event.isRecurring()) {
          const occ = this.occurrence(base, event, event.startDate, event.endDate, null, false);
          if (occ && new Date(occ.endMs) > start && new Date(occ.startMs) < end) out.push(occ);
          continue;
        }
        const rrule = recurData(master);
        const durationMs = event.endDate ? event.endDate.toJSDate() - event.startDate.toJSDate() : 0;
        // Exceptions can move an occurrence; a day of slack keeps those that moved into range.
        const earliest = start.getTime() - durationMs - 86400000;
        const it = event.iterator();
        for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n += 1, next = it.next()) {
          const t = next.toJSDate().getTime();
          if (t >= end.getTime() + 86400000) break;
          if (t < earliest) continue;
          const details = event.getOccurrenceDetails(next);
          if (details.startDate.toJSDate() >= end || details.endDate.compare(rangeStart) <= 0) continue;
          const occ = this.occurrence(base, details.item, details.startDate, details.endDate, details.recurrenceId, true, rrule);
          if (occ) out.push(occ);
        }
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  occurrence(base, event, startDate, endDate, recurrenceId, recurring, rrule = null) {
    if (!startDate) return null;
    const allDay = startDate.isDate;
    const end = endDate || startDate.clone();
    if (allDay && end.compare(startDate) <= 0) {
      end.day += 1; // DTSTART only: a one-day event
      end.normalize();
    }
    const startMs = startDate.toJSDate().getTime();
    const endMs = end.toJSDate().getTime();
    const rid = recurrenceId ? (recurrenceId.isDate ? dateString(recurrenceId) : recurrenceId.toJSDate().toISOString()) : null;
    return {
      ...base,
      key: `${base.calendarId}/${base.file}#${rid || ''}`,
      title: event.summary || 'New Event',
      location: event.location || '',
      notes: event.description || '',
      url: event.component.getFirstPropertyValue('url') || '',
      allDay,
      start: allDay ? dateString(startDate) : new Date(startMs).toISOString(),
      end: allDay ? dateString(end) : new Date(endMs).toISOString(),
      startMs,
      endMs,
      recurring,
      recurrenceId: rid,
      exception: recurring && event.component.hasProperty('recurrence-id'),
      rrule,
      alarm: alarmMinutes(event.component),
    };
  }

  /**
   * Create or update an event. For an occurrence of a repeating event,
   * `recurrenceId` names it: an existing exception is edited in place,
   * otherwise the change applies to the whole series and times move by the
   * same amount the occurrence moved.
   */
  save(ev) {
    if (!ev.title || !ev.title.trim()) ev.title = 'New Event';
    if (!ev.file) return this.create(ev);
    let full = this.file(ev.calendarId, ev.file);
    if (ev.toCalendarId && ev.toCalendarId !== ev.calendarId) {
      const target = path.join(this.dir(ev.toCalendarId), ev.file);
      fs.renameSync(full, target);
      this.cache.delete(full);
      full = target;
      ev = { ...ev, calendarId: ev.toCalendarId };
    }
    const vcal = this.load(full);
    const vevents = vcal.getAllSubcomponents('vevent');
    const master = vevents.find((v) => !v.hasProperty('recurrence-id')) || vevents[0];
    let target = master;
    if (ev.recurrenceId) {
      const exception = vevents.find((v) => {
        const rid = v.getFirstPropertyValue('recurrence-id');
        return rid && (rid.isDate ? dateString(rid) : rid.toJSDate().toISOString()) === ev.recurrenceId;
      });
      if (exception) target = exception;
    }
    const event = new ICAL.Event(target);
    if (target === master && ev.recurrenceId && master.hasProperty('rrule')) {
      // Move the series by however far this occurrence moved.
      const old = event.getOccurrenceDetails(ev.recurrenceId.length === 10 ? dateFromString(ev.recurrenceId) : ICAL.Time.fromJSDate(new Date(ev.recurrenceId), true));
      const shiftMs = parseTime(ev.start, ev.allDay) - old.startDate.toJSDate().getTime();
      const durationMs = parseTime(ev.end, ev.allDay) - parseTime(ev.start, ev.allDay);
      const newStart = new Date(event.startDate.toJSDate().getTime() + shiftMs);
      setTimes(event, newStart, new Date(newStart.getTime() + durationMs), ev.allDay);
    } else {
      setTimes(event, new Date(parseTime(ev.start, ev.allDay)), new Date(parseTime(ev.end, ev.allDay)), ev.allDay);
    }
    applyFields(event, ev, target === master);
    stamp(target);
    writeAtomic(full, vcal.toString());
    this.cache.delete(full);
    return { calendarId: ev.calendarId, file: path.basename(full), uid: event.uid };
  }

  create(ev) {
    const uid = crypto.randomUUID().toUpperCase();
    const vcal = new ICAL.Component(['vcalendar', [], []]);
    vcal.updatePropertyWithValue('prodid', PRODID);
    vcal.updatePropertyWithValue('version', '2.0');
    vcal.updatePropertyWithValue('calscale', 'GREGORIAN');
    const vevent = new ICAL.Component('vevent');
    vcal.addSubcomponent(vevent);
    const event = new ICAL.Event(vevent);
    event.uid = uid;
    vevent.updatePropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
    setTimes(event, new Date(parseTime(ev.start, ev.allDay)), new Date(parseTime(ev.end, ev.allDay)), ev.allDay);
    applyFields(event, ev, true);
    stamp(vevent);
    const file = `${uid}.ics`;
    writeAtomic(path.join(this.dir(ev.calendarId), file), vcal.toString());
    return { calendarId: ev.calendarId, file, uid };
  }

  /** scope 'one' adds an EXDATE (or drops the exception); 'all' deletes the file. */
  remove({ calendarId, file, scope = 'all', recurrenceId = null }) {
    const full = this.file(calendarId, file);
    if (scope === 'all' || !recurrenceId) {
      fs.unlinkSync(full);
      this.cache.delete(full);
      return;
    }
    const vcal = this.load(full);
    const vevents = vcal.getAllSubcomponents('vevent');
    const master = vevents.find((v) => !v.hasProperty('recurrence-id')) || vevents[0];
    for (const v of vevents) {
      const rid = v.getFirstPropertyValue('recurrence-id');
      if (rid && (rid.isDate ? dateString(rid) : rid.toJSDate().toISOString()) === recurrenceId) vcal.removeSubcomponent(v);
    }
    const exdate = recurrenceId.length === 10 ? dateFromString(recurrenceId) : ICAL.Time.fromJSDate(new Date(recurrenceId), true);
    const prop = master.addPropertyWithValue('exdate', exdate);
    if (exdate.isDate) prop.setParameter('value', 'DATE');
    stamp(master);
    writeAtomic(full, vcal.toString());
    this.cache.delete(full);
  }
}

function parseTime(value, allDay) {
  if (allDay) {
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return new Date(value).getTime();
}

/** Keep the event's existing time zone when it has one; new times are UTC. */
function setTimes(event, start, end, allDay) {
  if (allDay) {
    const s = ICAL.Time.fromData({ year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate(), isDate: true });
    let e = ICAL.Time.fromData({ year: end.getFullYear(), month: end.getMonth() + 1, day: end.getDate(), isDate: true });
    if (e.compare(s) <= 0) {
      e = s.clone();
      e.day += 1;
      e.normalize();
    }
    event.startDate = s;
    event.endDate = e;
    return;
  }
  const zone = event.startDate && !event.startDate.isDate ? event.startDate.zone : null;
  const toTime = (d) => {
    const utc = ICAL.Time.fromJSDate(d, true);
    if (zone && zone.tzid && zone.tzid !== 'UTC' && zone.tzid !== 'floating') return utc.convertToZone(zone);
    return utc;
  };
  event.startDate = toTime(start);
  event.endDate = toTime(end > start ? end : new Date(start.getTime() + 30 * 60000));
}

function applyFields(event, ev, isMaster) {
  const vevent = event.component;
  event.summary = ev.title.trim();
  setOrRemove(vevent, 'location', ev.location);
  setOrRemove(vevent, 'description', ev.notes);
  setOrRemove(vevent, 'url', ev.url);
  if (isMaster && ev.rrule !== undefined) {
    vevent.removeAllProperties('rrule');
    if (ev.rrule && ev.rrule.freq) {
      const data = { freq: ev.rrule.freq, interval: ev.rrule.interval || 1 };
      if (ev.rrule.count) data.count = ev.rrule.count;
      if (ev.rrule.until) data.until = ev.rrule.until.length === 10 ? dateFromString(ev.rrule.until) : ICAL.Time.fromJSDate(new Date(ev.rrule.until), true);
      vevent.addPropertyWithValue('rrule', ICAL.Recur.fromData(data));
    }
  }
  if (ev.alarm !== undefined) {
    for (const a of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(a);
    if (ev.alarm !== null && ev.alarm !== '' && !Number.isNaN(Number(ev.alarm))) {
      const valarm = new ICAL.Component('valarm');
      valarm.updatePropertyWithValue('action', 'DISPLAY');
      valarm.updatePropertyWithValue('description', 'Reminder');
      valarm.updatePropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Number(ev.alarm) * 60));
      vevent.addSubcomponent(valarm);
    }
  }
}

function setOrRemove(comp, name, value) {
  if (value && String(value).trim()) comp.updatePropertyWithValue(name, String(value));
  else comp.removeAllProperties(name);
}

function stamp(vevent) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  const seq = Number(vevent.getFirstPropertyValue('sequence') || 0);
  vevent.updatePropertyWithValue('sequence', seq + 1);
}

function writeAtomic(full, content) {
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, full);
}

module.exports = { CalendarStore, normColor };
