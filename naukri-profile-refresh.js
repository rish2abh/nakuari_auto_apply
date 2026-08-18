/**
 * Naukri Profile Refresh — toggles a trailing "." on the resume headline
 * so the profile counts as "updated" every run.
 *
 * Hourly:  Windows Task Scheduler runs:  node naukri-profile-refresh.js   (off-screen Chrome)
 * Debug:   node naukri-profile-refresh.js login                           (visible Chrome window)
 *
 * Login is automatic: if the Naukri session is gone, it signs in with the
 * Google account below. State lives in the headline itself:
 * ends with "." → remove it, else add it.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CREDS, naukriProfileUrl } = require('./config'); // credentials + profile URL come from .env, never hard-coded

const PROFILE_URL = naukriProfileUrl;
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-refresh.log');
const ERROR_SHOT = path.join(__dirname, 'naukri-refresh-error.png');
const LOGIN_MODE = process.argv[2] === 'login';
const LAST_AUTH_FAIL = path.join(__dirname, '.last-auth-fail');

class AutomationError extends Error {
  constructor(category, msg) {
    super(msg);
    this.category = category;
  }
}

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try {
    // rotate if too large (>5MB)
    if (fs.existsSync(LOG_FILE)) {
      const s = fs.statSync(LOG_FILE).size;
      if (s > 5 * 1024 * 1024) {
        const bak = path.join(__dirname, `naukri-refresh.${Date.now()}.log`);
        fs.renameSync(LOG_FILE, bak);
      }
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    console.error('failed to write log', e && e.message);
  }
};

const onProfile = (url) => url.pathname.startsWith('/mnjuser');

async function safeGoto(page, url, options = {}, retry = false) {
  try {
    return await page.goto(url, options);
  } catch (err) {
    const wrapped = new AutomationError('NETWORK_ERROR', err && err.message ? err.message : String(err));
    if (retry) {
      await page.waitForTimeout(5000);
      try { return await page.goto(url, options); } catch (err2) { throw new AutomationError('NETWORK_ERROR', err2 && err2.message ? err2.message : String(err2)); }
    }
    throw wrapped;
  }
}

async function googleLogin(ctx, page) {
  log('Session gone — signing in with Google...');
  await safeGoto(page, LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // Naukri's "Sign in with Google" is a plain div.socialbtn.google
  const googleBtn = page.locator('.socialbtn.google, [class*="socialbtn"][class*="google"]').first();
  await googleBtn.waitFor({ timeout: 20000 });
  await googleBtn.click();

  // The Google sign-in may open a popup OR replace the current tab — find it either way
  let g = null;
  for (let i = 0; i < 30 && !g; i++) {
    await page.waitForTimeout(1000);
    g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
  }
  if (!g) {
    try { fs.writeFileSync(LAST_AUTH_FAIL, String(Date.now())); } catch (e) {}
    throw new AutomationError('AUTH_ERROR', 'Google sign-in page never appeared');
  }
  await g.waitForLoadState('domcontentloaded');

  // Account already known to this Chrome profile → click it, else full email+password
  const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
  if (await knownAccount.isVisible().catch(() => false)) {
    await knownAccount.click();
  } else {
    const emailBox = g.locator('input#identifierId, input[type="email"], input[name="identifier"]').first();
    await emailBox.waitFor({ state: 'visible', timeout: 60000 });
    await emailBox.fill(CREDS.email);
    await g.locator('#identifierNext, button:has-text("Next")').first().click();
    const passBox = g.locator('input[type="password"], input[name="Passwd"]').first();
    await passBox.waitFor({ state: 'visible', timeout: 60000 });
    await passBox.fill(CREDS.password);
    await g.locator('#passwordNext, button:has-text("Next")').first().click();
  }

  // Wait until any tab lands back on the logged-in naukri profile
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    // consent screen ("Continue") sometimes follows the password step
    if (!g.isClosed()) {
      await g.locator('button:has-text("Continue")').first().click({ timeout: 500 }).catch(() => {});
    }
    const done = ctx.pages().find((p) => {
      try { return onProfile(new URL(p.url())); } catch { return false; }
    });
    if (done) { log('Google login OK, session saved.'); return done; }
    if (g.isClosed() || /naukri\.com/.test(g.url())) {
      // auth finished but landed elsewhere — go to the profile directly
      try {
        await safeGoto(page, PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        if (e && e.category === 'NETWORK_ERROR') log(`[NETWORK_ERROR] ${e.message}`);
      }
      if (onProfile(new URL(page.url()))) { log('Google login OK, session saved.'); return page; }
    }
    await page.waitForTimeout(2000);
  }
  try { fs.writeFileSync(LAST_AUTH_FAIL, String(Date.now())); } catch (e) {}
  throw new AutomationError(
    'AUTH_ERROR',
    'Google login did not complete — likely a 2-step verification prompt. ' +
    'Run "node naukri-profile-refresh.js login" and approve it once manually.'
  );
}

// Main run — with concurrency lock, timeout guard, and safer launch
(async () => {
  const LOCK_FILE = path.join(__dirname, '.run.lock');
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (!Number.isNaN(pid)) {
        try { process.kill(pid, 0); log('SKIP: previous run still active'); return; } catch (e) {}
      }
    } catch (e) {}
  }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) {}

  let ctx = null;
  let page = null;
  const killer = setTimeout(() => {
    log('ERROR: run exceeded max duration');
    process.exit(1);
  }, 8 * 60 * 1000);

  try {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1280, height: 850 },
        args: ['--disable-blink-features=AutomationControlled', ...(LOGIN_MODE ? [] : ['--window-position=-32000,-32000'])],
      });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/profile.*lock|SingletonLock/i.test(msg)) {
        log('[BROWSER_ERROR] profile locked, possible zombie process');
        process.exit(1);
      }
      throw e;
    }

    page = ctx.pages()[0] || (await ctx.newPage());

    // initial navigation: allow one retry with backoff
    await safeGoto(page, PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }, true);

    if (!onProfile(new URL(page.url()))) {
      page = await googleLogin(ctx, page);
    }
    if (!/\/mnjuser\/profile/.test(page.url())) {
      await safeGoto(page, PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    // Resume headline widget → pencil icon → textarea → save
    const editIcon = page.locator('#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit');
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();

    const textarea = page.locator('#resumeHeadlineTxt');
    await textarea.waitFor({ timeout: 15000 });
    const current = (await textarea.inputValue()).trimEnd();
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    await textarea.fill(updated);
    await page.getByRole('button', { name: /^save$/i }).first().click();
    await textarea.waitFor({ state: 'hidden', timeout: 15000 });

    // modal closing isn't proof the save stuck — reload from the server and re-read
    await safeGoto(page, PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await editIcon.first().waitFor({ timeout: 30000 });
    await editIcon.first().click();
    await textarea.waitFor({ timeout: 15000 });
    const saved = (await textarea.inputValue()).trimEnd();
    if (saved !== updated) {
      throw new Error(`save did not stick — server headline is "${saved.slice(0, 60)}", expected "${updated.slice(0, 60)}"`);
    }

    log(`OK: headline ${current.endsWith('.') ? 'dot removed' : 'dot added'} (verified) → "${updated.slice(0, 60)}"`);
  } catch (err) {
    try {
      const pages = (ctx && ctx.pages ? ctx.pages() : []);
      for (let i = 0; i < pages.length; i++) {
        await pages[i].screenshot({ path: ERROR_SHOT.replace('.png', `-${i}.png`) }).catch(() => {});
      }
    } catch (e) {}
    log(`[${err && err.category ? err.category : 'UNKNOWN_ERROR'}] ${String(err && err.message ? err.message.split('\n')[0] : err)}` + ' (screenshots: naukri-refresh-error-*.png)');
    process.exitCode = 1;
  } finally {
    clearTimeout(killer);
    try { if (ctx && ctx.close) await ctx.close(); } catch (e) {}
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  }
})();
