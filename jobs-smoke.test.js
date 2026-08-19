const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'jobs-sample.json');
assert.ok(fs.existsSync(file), 'jobs-sample.json should exist so the auto-apply flow can process candidates');
const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(Array.isArray(jobs) && jobs.length > 0, 'jobs-sample.json should contain at least one job');
console.log(`jobs sample OK: ${jobs.length} jobs`);
