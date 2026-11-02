'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function resolveExecutable(configPath = process.env.DSH_WECHAT_CONFIG || path.join(__dirname, '..', 'dsh-wechat-config.json')) {
  if (process.env.DSH_HARNESS_EXE) return process.env.DSH_HARNESS_EXE;
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { throw new Error('Invalid JSON in local configuration.'); }
  }
  if (config.harnessExecutable) return config.harnessExecutable;
  throw new Error('Set DSH_HARNESS_EXE or harnessExecutable in the local configuration before using this optional launcher.');
}

function launchHarness(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

if (require.main === module) {
  Promise.resolve().then(() => launchHarness(resolveExecutable())).catch((error) => {
    console.error('Harness launch failed: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { resolveExecutable, launchHarness };
