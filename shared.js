const fs = require('fs');
const path = require('path');

class AutomationError extends Error {
  constructor(category, msg) {
    super(msg);
    this.category = category;
    this.name = 'AutomationError';
  }
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    // ignore if directory already exists
  }
}

function rotateLogIfNeeded(logFile, maxBytes = 5 * 1024 * 1024) {
  if (!logFile || !fs.existsSync(logFile)) return;
  const size = fs.statSync(logFile).size;
  if (size > maxBytes) {
    const ts = Date.now();
    const rotated = path.join(path.dirname(logFile), `${path.basename(logFile, '.log')}.${ts}.log`);
    fs.renameSync(logFile, rotated);
  }
}

function log(msg, options = {}) {
  const logFile = options.logFile || path.join(__dirname, 'naukri-refresh.log');
  const category = options.category ? `[${options.category}]` : '';
  const line = `[${new Date().toLocaleString()}] ${category} ${msg}`.replace(/\s+/g, ' ').trim();
  console.log(line);
  try {
    rotateLogIfNeeded(logFile);
    fs.appendFileSync(logFile, line + '\n');
  } catch (err) {
    console.error('failed to write log', err && err.message);
  }
}

function parseLockContents(txt) {
  if (!txt || !txt.includes(':')) return null;
  const parts = txt.split(':');
  const pid = parseInt(parts[0], 10);
  const ts = parseInt(parts[1], 10) || 0;
  if (Number.isNaN(pid)) return null;
  return { pid, ts };
}

function acquireSharedLock(lockFile, options = {}) {
  const now = Date.now();
  const mine = `${process.pid}:${now}`;
  const skipMessage = options.skipMessage || 'SKIP: previous run still active';
  const staleMs = options.staleMs || 15 * 60 * 1000;

  try {
    fs.writeFileSync(lockFile, mine, { flag: 'wx' });
    return true;
  } catch (err) {
    if (!(err && err.code === 'EEXIST')) throw err;
    try {
      const txt = fs.readFileSync(lockFile, 'utf8');
      const lock = parseLockContents(txt);
      if (!lock) {
        log(skipMessage, { logFile: options.logFile, category: 'LOCK' });
        return false;
      }
      const age = now - lock.ts;
      if (age > staleMs) {
        try {
          fs.writeFileSync(lockFile, mine, { flag: 'w' });
          return true;
        } catch (writeErr) {
          log('SKIP: previous run lock present (could not reclaim)', { logFile: options.logFile, category: 'LOCK' });
          return false;
        }
      }
      try {
        process.kill(lock.pid, 0);
        log(skipMessage, { logFile: options.logFile, category: 'LOCK' });
        return false;
      } catch (e) {
        try {
          fs.writeFileSync(lockFile, mine, { flag: 'wx' });
          return true;
        } catch (writeErr) {
          log(skipMessage, { logFile: options.logFile, category: 'LOCK' });
          return false;
        }
      }
    } catch (readErr) {
      log('SKIP: previous run lock present (unreadable)', { logFile: options.logFile, category: 'LOCK' });
      return false;
    }
  }
}

function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch (err) {
    // ignore if lock absent
  }
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

module.exports = {
  AutomationError,
  ensureDir,
  log,
  rotateLogIfNeeded,
  acquireSharedLock,
  releaseLock,
  readJson,
  writeJson,
};
