'use strict';

const fs = require('node:fs');
const path = require('node:path');

function initConfig(rootDir = path.resolve(__dirname, '..'), configPath) {
  const source = path.join(rootDir, 'dsh-wechat-config.example.json');
  const destination = configPath || path.join(rootDir, 'dsh-wechat-config.json');
  try {
    // COPYFILE_EXCL guarantees an existing private configuration is never overwritten.
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return { created: true, path: destination };
  } catch (error) {
    if (error.code === 'EEXIST') return { created: false, path: destination };
    throw error;
  }
}

if (require.main === module) {
  try {
    const result = initConfig(undefined, process.env.DSH_WECHAT_CONFIG);
    console.log(result.created
      ? 'Created local configuration. Fill in the credentials for your selected transport.'
      : 'Local configuration already exists; left unchanged.');
  } catch (error) {
    console.error('Configuration initialization failed: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { initConfig };
