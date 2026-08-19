const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_FILE = path.join(__dirname, 'naukri-full-run.log');
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

function log(msg, category = 'RUN') {
  const line = `[${new Date().toLocaleString()}] [${category}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (err) {
    // ignore log failures; the terminal still shows the lifecycle
  }
}

function runStage(stageName, scriptName) {
  log(`STEP_START ${stageName} -> node ${scriptName}`, 'STEP');

  if (DRY_RUN) {
    log(`DRY_RUN skip: ${stageName} (${scriptName})`, 'STEP');
    return true;
  }

  const result = spawnSync(process.execPath, [scriptName], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    log(`STEP_ERROR ${stageName}: ${result.error.message}`, 'ERROR');
    return false;
  }

  if (result.status !== 0) {
    log(`STEP_FAIL ${stageName}: exit=${result.status}`, 'ERROR');
    return false;
  }

  log(`STEP_OK ${stageName}`, 'STEP');
  return true;
}

(async () => {
  log('FULL_RUN_START', 'START');

  const refreshOk = runStage('PROFILE_REFRESH', 'naukri-profile-refresh.js');
  if (!refreshOk) {
    log('Stopping because profile refresh/login step failed.', 'ERROR');
    process.exitCode = 1;
    return;
  }

  const applyOk = runStage('AUTO_APPLY', 'naukri-auto-apply.js');
  if (!applyOk) {
    log('Stopping because auto-apply step failed.', 'ERROR');
    process.exitCode = 1;
    return;
  }

  log('FULL_RUN_COMPLETE', 'SUMMARY');
})();
