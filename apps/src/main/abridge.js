'use strict';
// Talking to the `abridge` command: every iCloud operation the apps do goes
// through it, so the apps, the terminal and the sync timer share one set of
// sessions, locks and pinned upstream tools.

const { spawn, execFileSync } = require('node:child_process');

function abridgeBin() {
  return process.env.ABRIDGE_BIN || 'abridge';
}

/** Where abridge keeps everything (`abridge paths`). */
function readPaths() {
  const out = execFileSync(abridgeBin(), ['paths'], { encoding: 'utf8', timeout: 20000 });
  const paths = {};
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) paths[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return paths;
}

/** Run `abridge ARGS...`; never rejects, resolves to {ok, code, stdout, stderr}. */
function run(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(abridgeBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** The most useful single line of a failed run, for a toast. */
function errorLine(result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const flagged = lines.filter((l) => /^(error|iCloud error|warning)\b|FAILED|refus/i.test(l));
  return (flagged.pop() || lines.pop() || `abridge exited with ${result.code}`).replace(/^(error|warning):\s*/i, '');
}

module.exports = { abridgeBin, readPaths, run, errorLine };
