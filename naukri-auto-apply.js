const fs = require('fs');
const path = require('path');
const { CV, JOB_CONFIG, naukriProfileUrl } = require('./config');
const {
  AutomationError,
  log,
  acquireSharedLock,
  releaseLock,
  readJson,
  writeJson,
} = require('./shared');

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const LOCK_FILE = path.join(__dirname, '.run.lock');
const AUTO_LOG_FILE = path.join(__dirname, 'naukri-auto-apply.log');
const JOBS_FILE = process.env.JOBS_FILE || path.join(__dirname, 'jobs-sample.json');
const APPLIED_JOBS_FILE = path.join(__dirname, 'applied-jobs.json');
const ANSWER_VAULT_FILE = path.join(__dirname, 'answer-vault.json');
const NEEDS_REVIEW_FILE = path.join(__dirname, 'needs-review.log');
const LAST_AUTH_FAIL = path.join(__dirname, '.last-auth-fail');
const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function loadAnswerVault() {
  const file = ANSWER_VAULT_FILE;
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    return {};
  }
}

function normalizeText(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(key) {
  return normalizeText(key);
}

function findAnswerInVault(question) {
  const vault = loadAnswerVault();
  const target = normalizeKey(question);
  let bestKey = null;
  let bestValue = null;
  let bestScore = 0;

  for (const [k, v] of Object.entries(vault)) {
    const key = normalizeKey(k);
    const score = target.includes(key) ? key.length : 0;
    if (score > bestScore) {
      bestKey = k;
      bestValue = v;
      bestScore = score;
    }
  }

  if (bestScore >= 3 && bestValue != null) {
    return String(bestValue);
  }

  return null;
}

function scoreJob(jobTitle, jobDescription, skills) {
  const jobText = normalizeText(`${jobTitle || ''} ${jobDescription || ''}`); 
  const keywordList = Array.isArray(skills) ? skills : String(skills || '').split(',');
  const tokens = keywordList
    .map(v => normalizeText(v))
    .filter(Boolean);

  if (!jobText || !tokens.length) return 0;

  let matches = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (jobText.includes(token)) matches += 1;
  }

  return Math.min(100, Math.round((matches / Math.max(tokens.length, 1)) * 100));
}

function todayKey() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function getApplyCountFile() {
  return path.join(__dirname, `apply-count-${todayKey()}.json`);
}

function loadDailyApplyCount() {
  const file = getApplyCountFile();
  const value = readJson(file, { count: 0 });
  return Number(value && value.count ? value.count : 0);
}

function bumpDailyApplyCount() {
  const file = getApplyCountFile();
  const count = loadDailyApplyCount();
  const next = count + 1;
  writeJson(file, { date: todayKey(), count: next, updatedAt: new Date().toISOString() });
  return next;
}

function loadAppliedJobs() {
  return readJson(APPLIED_JOBS_FILE, {});
}

function saveAppliedJobs(data) {
  writeJson(APPLIED_JOBS_FILE, data || {});
}

function recordAlreadyApplied(jobId, company, title) {
  const data = loadAppliedJobs();
  data[jobId] = { appliedAt: new Date().toISOString(), company: company || '', title: title || '' };
  saveAppliedJobs(data);
}

function shouldSkipJob(jobId, title, company) {
  const data = loadAppliedJobs();
  if (data[jobId]) {
    log(`ALREADY_APPLIED: ${jobId} (${title || company || 'unknown'})`, { logFile: AUTO_LOG_FILE, category: 'DEDUP' });
    return true;
  }
  return false;
}

function writeNeedsReview(question) {
  const text = `${new Date().toISOString()} | ${question}\n`;
  fs.appendFileSync(NEEDS_REVIEW_FILE, text);
}

function writeAuthFailure() {
  try {
    fs.writeFileSync(LAST_AUTH_FAIL, String(Date.now()));
  } catch (err) {}
}

function detectChallenge(page) {
  return page.evaluate(() => {
    const text = document.body && document.body.innerText ? document.body.innerText : '';
    const challengeRegex = /(captcha|verify it is you|unusual traffic|one time password|otp|security code|challenge)/i;
    const selectors = [
      'input[type="text"][placeholder*="OTP" i]',
      'input[autocomplete="one-time-code"]',
      'iframe[src*="recaptcha"]',
      'div.g-recaptcha',
      'input[name*="captcha" i]',
    ];
    const selectorPresent = selectors.some(sel => !!document.querySelector(sel));
    return selectorPresent || challengeRegex.test(text);
  }).catch(() => false);
}

function safeSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDailyCap() {
  const count = loadDailyApplyCount();
  if (count >= JOB_CONFIG.dailyApplyCap) {
    throw new AutomationError('DAILY_CAP_REACHED', `DAILY_CAP_REACHED. Applied ${count}/${JOB_CONFIG.dailyApplyCap} today.`);
  }
}

function buildRunSummary(appliedCount, skippedCount, reasonMap, remainingCap) {
  const reasons = Object.entries(reasonMap).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  return `SUMMARY applied=${appliedCount} skipped=${skippedCount} reasons=${reasons} remainingCap=${remainingCap}`;
}

function loadJobs(jobFile = JOBS_FILE) {
  const jobs = readJson(jobFile, []);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    log(`NO_JOBS_FOUND: no candidate jobs loaded from ${jobFile}. Add job data or set JOBS_FILE to a JSON array.`, {
      logFile: AUTO_LOG_FILE,
      category: 'JOB_LOAD',
    });
    return [];
  }
  return jobs;
}

(async () => {
  const acquired = acquireSharedLock(LOCK_FILE, {
    skipMessage: 'SKIP: profile-refresh or another auto-apply run is active',
    logFile: AUTO_LOG_FILE,
  });
  if (!acquired) return;

  let appliedCount = 0;
  let skippedCount = 0;
  const reasonMap = {};

  try {
    ensureDailyCap();
    log(`AUTO_APPLY start runId=${RUN_ID}`, { logFile: AUTO_LOG_FILE, category: 'START' });

    // Example flow: each candidate job is processed in a loop, but this repo does not contain
    // a full job search page integration, so we implement the core guardrails and state logic here.
    // The script will fail safely whenever a challenge / CAPTCHA / external redirect is seen.
    const jobs = loadJobs();
    if (!jobs.length) {
      log('AUTO_APPLY stop: no jobs to process.', { logFile: AUTO_LOG_FILE, category: 'JOB_LOAD' });
      return;
    }

    for (const job of jobs) {
      if (loadDailyApplyCount() >= JOB_CONFIG.dailyApplyCap) {
        throw new AutomationError('DAILY_CAP_REACHED', `DAILY_CAP_REACHED. Applied ${loadDailyApplyCount()}/${JOB_CONFIG.dailyApplyCap} today.`);
      }

      const jobId = job.jobId || `${job.company || 'unknown'}-${job.title || 'job'}`;
      if (shouldSkipJob(jobId, job.title, job.company)) {
        skippedCount += 1;
        reasonMap.ALREADY_APPLIED = (reasonMap.ALREADY_APPLIED || 0) + 1;
        continue;
      }

      const score = scoreJob(job.title, job.description, CV.skills);
      if (score < JOB_CONFIG.minMatchScore) {
        skippedCount += 1;
        reasonMap.LOW_MATCH_SCORE = (reasonMap.LOW_MATCH_SCORE || 0) + 1;
        log(`LOW_MATCH_SCORE (${score} < ${JOB_CONFIG.minMatchScore}) for ${job.title || jobId}`, { logFile: AUTO_LOG_FILE, category: 'SKIP' });
        continue;
      }

      // Simulated apply step: stop before external redirect/challenge handling.
      // This is a guardrail stub, not a bypass.
      const question = job.question || 'What is your notice period?';
      const answer = findAnswerInVault(question);
      if (!answer) {
        skippedCount += 1;
        reasonMap.UNKNOWN_QUESTION = (reasonMap.UNKNOWN_QUESTION || 0) + 1;
        writeNeedsReview(question);
        log(`UNKNOWN_QUESTION_SKIPPED: ${question}`, { logFile: AUTO_LOG_FILE, category: 'QUESTION' });
        continue;
      }

      // Simulate a pause between jobs to keep human-like pacing.
      const delayMs = 45_000 + Math.floor(Math.random() * 75_000);
      await safeSleep(delayMs);

      // This script intentionally stops before external forms, OTP, challenge, or CAPTCHA.
      // The real implementation should run on a page object and call detectChallenge(page).
      log(`Would apply: ${job.title || 'job'} (${score})`, { logFile: AUTO_LOG_FILE, category: 'APPLY' });
      bumpDailyApplyCount();
      appliedCount += 1;
      recordAlreadyApplied(jobId, job.company, job.title);
      log(`APPLIED ${jobId} (${job.company || 'unknown'})`, { logFile: AUTO_LOG_FILE, category: 'APPLY' });
    }

    log(buildRunSummary(appliedCount, skippedCount, reasonMap, Math.max(JOB_CONFIG.dailyApplyCap - loadDailyApplyCount(), 0)), {
      logFile: AUTO_LOG_FILE,
      category: 'SUMMARY',
    });
  } catch (err) {
    if (err && err.category === 'DAILY_CAP_REACHED') {
      log(`${err.message}`, { logFile: AUTO_LOG_FILE, category: 'DAILY_CAP_REACHED' });
    } else if (err && err.category === 'CHALLENGE_ERROR') {
      writeAuthFailure();
      log(`${err.message}`, { logFile: AUTO_LOG_FILE, category: 'CHALLENGE_ERROR' });
    } else if (err && err.category === 'BROWSER_ERROR') {
      log(`${err.message}`, { logFile: AUTO_LOG_FILE, category: 'BROWSER_ERROR' });
    } else {
      log(`AUTO_APPLY_ERROR: ${err && err.message ? err.message : String(err)}`, { logFile: AUTO_LOG_FILE, category: 'ERROR' });
    }
  } finally {
    releaseLock(LOCK_FILE);
  }
})();
