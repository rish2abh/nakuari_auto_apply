/**
 * Loads all personal data + credentials from .env so nothing sensitive lives in code.
 * Tiny hand-rolled parser — no dependency needed for a flat KEY=value file.
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const E = loadEnv(path.join(__dirname, '.env'));
const g = (k, d = '') => (E[k] != null && E[k] !== '' ? E[k] : (process.env[k] || d));

const REQUIRED = ['GOOGLE_EMAIL','GOOGLE_PASSWORD','NAME','EMAIL'];
const missing = REQUIRED.filter((k) => !g(k));
if (missing.length) {
  console.error('[config] missing required .env values:', missing.join(', '));
  process.exit(1);
}

const clampDailyApplyCap = (value) => {
  const n = Number(value ?? 15);
  if (Number.isFinite(n) && n > 50) {
    console.warn('[config] DAILY_APPLY_CAP exceeds 50; clamped to 50.');
    return 50;
  }
  return Number.isFinite(n) && n > 0 ? n : 15;
};

const JOB_CONFIG = {
  jobKeywords: (g('JOB_KEYWORDS') || '').split(',').map((s) => s.trim()).filter(Boolean),
  jobLocation: g('JOB_LOCATION', ''),
  minCtc: Number(g('MIN_CTC') || 0),
  maxCtc: Number(g('MAX_CTC') || 0),
  experienceRange: g('EXPERIENCE_RANGE', ''),
  dailyApplyCap: clampDailyApplyCap(g('DAILY_APPLY_CAP', 15)),
  minMatchScore: Math.max(0, Math.min(100, Number(g('MIN_MATCH_SCORE', 15) || 15))),
};

const CV = {
  name: g('NAME'),
  email: g('EMAIL'),
  phone: g('PHONE'),
  location: g('LOCATION'),
  currentRole: g('CURRENT_ROLE'),
  company: g('COMPANY') || (g('CURRENT_ROLE').split(' at ')[1] || '').split(' (')[0],
  education: g('EDUCATION'),
  yearsOfExperience: g('YEARS_EXPERIENCE'),
  skills: g('SKILLS'),
  highlights: g('HIGHLIGHTS').split('||').map((s) => s.trim()).filter(Boolean),
  // application answers
  noticePeriod: g('NOTICE_PERIOD'),
  currentCTC: g('CURRENT_CTC'),                 // bare number for chatbots, e.g. "10"
  expectedCTC: g('EXPECTED_CTC'),               // e.g. "18-25"
  currentSalary: g('CURRENT_CTC') + ' LPA',     // formatted for free-text fields
  expectedSalary: g('EXPECTED_CTC') + ' LPA',
  dob: g('DOB'),
  gender: g('GENDER'),
  workAuth: g('WORK_AUTH', 'Authorized to work in my country of residence.'),
  // links
  github: g('GITHUB_URL'),
  linkedin: g('LINKEDIN_URL'),
  portfolio: g('PORTFOLIO_URL'),
  links: `GitHub: ${g('GITHUB_URL')} | LinkedIn: ${g('LINKEDIN_URL')} | Portfolio: ${g('PORTFOLIO_URL')}`,
  // derived sentences
  remoteOk: 'Yes, I am fully set up for remote work and also open to hybrid/onsite.',
  relocate: `Yes, I am open to relocation. I am currently based in ${g('LOCATION')}.`,
  startDate: `I can start within ${g('NOTICE_PERIOD')}.`,
};

const CREDS = { email: g('GOOGLE_EMAIL') || g('EMAIL'), password: g('GOOGLE_PASSWORD') };
const geminiKey = g('GEMINI_KEY');
const naukriProfileUrl = g('NAUKRI_PROFILE_URL', 'https://www.naukri.com/mnjuser/profile');

module.exports = { CV, CREDS, geminiKey, naukriProfileUrl, JOB_CONFIG };
