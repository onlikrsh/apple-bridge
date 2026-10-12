'use strict';
// One queue of sync jobs per app. Jobs run one at a time (abridge also takes
// a lock, but queueing here keeps the status line honest), a job requested
// while the same kind is already waiting is merged into it, and "push soon"
// requests are debounced so typing doesn't start a push per keystroke.

class Syncer {
  /**
   * @param {object} opts
   * @param {(kind: string) => Promise<{ok: boolean, message?: string}>} opts.perform
   * @param {(status: object) => void} opts.onStatus
   * @param {() => void} [opts.onDone] called after every successful job
   */
  constructor({ perform, onStatus, onDone = () => {} }) {
    this.perform = perform;
    this.onStatus = onStatus;
    this.onDone = onDone;
    this.queue = [];
    this.running = null;
    this.timers = new Map();
    this.status = { state: 'idle', message: '', lastSync: null };
    this.interval = null;
  }

  /** Queue `kind` now, or after `delayMs` of quiet if a delay is given. */
  request(kind, delayMs = 0) {
    clearTimeout(this.timers.get(kind));
    if (delayMs > 0) {
      this.setStatus({ state: this.running ? 'syncing' : 'pending' });
      this.timers.set(kind, setTimeout(() => this.request(kind), delayMs));
      return;
    }
    this.timers.delete(kind);
    if (!this.queue.includes(kind)) this.queue.push(kind);
    this.pump();
  }

  /** Resolves when nothing is queued, running or waiting on a debounce. */
  async idle() {
    while (this.running || this.queue.length || this.timers.size) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  every(kind, ms) {
    clearInterval(this.interval);
    this.interval = setInterval(() => this.request(kind), ms);
  }

  stop() {
    clearInterval(this.interval);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const kind = this.queue.shift();
    this.running = kind;
    this.setStatus({ state: 'syncing', message: '' });
    let result;
    try {
      result = await this.perform(kind);
    } catch (err) {
      result = { ok: false, message: String(err && err.message ? err.message : err) };
    }
    this.running = null;
    if (result.ok) {
      this.setStatus({ state: this.timers.size ? 'pending' : 'idle', message: '', lastSync: Date.now() });
      this.onDone(kind);
    } else {
      this.setStatus({ state: 'error', message: result.message || 'Sync failed' });
    }
    this.pump();
  }
}

module.exports = { Syncer };
