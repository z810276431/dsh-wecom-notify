'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PROJECT_NAME = 'dsh-wecom-notify';
// Keep this list explicit: local configuration, runtime data and dependencies
// must never become release inputs, even if someone changes .gitignore.
const PUBLIC_FILES = Object.freeze([
  '.github/workflows/ci.yml',
  '.gitignore',
  'README.md',
  'dsh-wechat-config.example.json',
  'dsh-wechat-notify.js',
  'dsh-wecom-aibot.js',
  'package.json',
  'pnpm-lock.yaml',
  'run-wechat-notify.cmd',
  'scripts/build-release.js',
  'scripts/init-config.js',
  'scripts/launch-harness.js',
  'start-harness.cmd',
  'test/notifier.test.js',
  'test/release.test.js',
  '.github/workflows/release.yml',
].sort());

const EMPTY_EXAMPLE_FIELDS = Object.freeze([
  'wecomWebhook',
  'pushplus.token',
  'serverchan.sendKey',
  'aibot.botId',
  'aibot.secret',
  'sessionsRoot',
  'aibot.chatFile',
  'harnessExecutable',
]);
// Only these published defaults belong in a release example. User-specific
// values belong in the ignored config created by init:config, not this file.
const EXAMPLE_SCHEMA = Object.freeze({
  transport: 'webhook',
  wecomWebhook: '',
  pushplus: Object.freeze({ token: '', template: 'markdown', channel: 'wechat' }),
  serverchan: Object.freeze({ sendKey: '' }),
  aibot: Object.freeze({ botId: '', secret: '', chatFile: '' }),
  sessionsRoot: '',
  pollMs: 2000,
  notifyOn: Object.freeze(['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens']),
  mention: '',
  maxTextChars: 220,
  lockPort: 39271,
  requireHarness: true,
  harnessPort: 0,
  harnessProcess: 'DeepSeek Harness.exe',
  harnessExecutable: '',
});
const UINT32_MAX = 0xffffffff;
const ZIP_UTF8 = 0x0800;
const ZIP_DATE = 0x0021; // 1980-01-01: fixed DOS timestamp, independent of timezone.
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  CRC_TABLE[index] = crc >>> 0;
}

function assertSafeFilename(name) {
  if (typeof name !== 'string' || !name || path.posix.isAbsolute(name)
      || path.posix.normalize(name) !== name
      || /[<>:"\\|?*\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Unsafe release filename.');
  }
  for (const segment of name.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/u.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw new Error('Unsafe release filename.');
    }
  }
  if (Buffer.byteLength(name, 'utf8') > 0xffff) {
    throw new Error('Release filename is too long for ZIP32.');
  }
}

function inspect(filename, missingMessage) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(missingMessage);
    throw error;
  }
}

function assertDirectory(filename, label) {
  const stat = inspect(filename, `${label} is missing.`);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
}

function readPublicFile(rootDir, name) {
  assertSafeFilename(name);
  const segments = name.split('/');
  let filename = rootDir;
  let stat;
  for (let index = 0; index < segments.length; index += 1) {
    filename = path.join(filename, segments[index]);
    const label = segments.slice(0, index + 1).join('/');
    stat = inspect(filename, `Missing public file: ${name}`);
    if (stat.isSymbolicLink()) throw new Error(`Public path must not be a symlink: ${label}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Public parent must be a directory: ${label}`);
    }
  }
  if (!stat.isFile()) throw new Error(`Public input must be a regular file: ${name}`);
  if (stat.nlink > 1) throw new Error(`Public input must not be a hard link: ${name}`);
  if (stat.size > UINT32_MAX) throw new Error(`Public input is too large for ZIP32: ${name}`);

  let descriptor;
  try {
    // O_NOFOLLOW protects the final component where the platform supports it;
    // fstat also detects replacement between inspection and opening.
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.nlink > 1) throw new Error(`Public input must not be a hard link: ${name}`);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`Public input changed while opening: ${name}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertUniqueJsonKeys(source, label) {
  // JSON.parse has already checked grammar, but loses earlier duplicate keys.
  // Walk the original text and decode each object key before comparing it.
  let position = 0;
  const invalid = () => { throw new Error(`Invalid JSON in ${label}.`); };
  const whitespace = () => {
    while (/[ \t\r\n]/u.test(source[position] || '')) position += 1;
  };
  const consume = (character) => {
    whitespace();
    if (source[position] !== character) invalid();
    position += 1;
  };
  const string = () => {
    whitespace();
    if (source[position] !== '"') invalid();
    const start = position;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      position += 1;
      if (character === '\\') position += 1;
      else if (character === '"') return JSON.parse(source.slice(start, position));
    }
    invalid();
  };
  const visit = (depth) => {
    if (depth > 32) throw new Error(`JSON nesting is too deep in ${label}.`);
    whitespace();
    if (source[position] === '{') {
      position += 1;
      whitespace();
      if (source[position] === '}') { position += 1; return; }
      const keys = new Set();
      for (;;) {
        const key = string();
        // Never echo a rejected key: a property name can itself be private.
        if (keys.has(key)) throw new Error(`Duplicate JSON key in ${label}.`);
        keys.add(key);
        consume(':');
        visit(depth + 1);
        whitespace();
        if (source[position] === '}') { position += 1; return; }
        consume(',');
      }
    }
    if (source[position] === '[') {
      position += 1;
      whitespace();
      if (source[position] === ']') { position += 1; return; }
      for (;;) {
        visit(depth + 1);
        whitespace();
        if (source[position] === ']') { position += 1; return; }
        consume(',');
      }
    }
    if (source[position] === '"') { string(); return; }
    const start = position;
    while (position < source.length && !/[,}\] \t\r\n]/u.test(source[position])) position += 1;
    if (position === start) invalid();
  };
  visit(0);
  whitespace();
  if (position !== source.length) invalid();
}

function parseObject(buffer, label) {
  const source = buffer.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(buffer)) throw new Error(`Invalid UTF-8 in ${label}.`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in ${label}.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  assertUniqueJsonKeys(source, label);
  return value;
}

function validateManifest(manifest) {
  if (manifest.name !== PROJECT_NAME) {
    throw new Error(`package.json name must be "${PROJECT_NAME}".`);
  }
  const version = manifest.version;
  const match = typeof version === 'string' && version.length <= 128
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match || match[0] !== version
      || (match[4] && match[4].split('.').some((part) => /^0\d+$/u.test(part)))) {
    throw new Error('package.json version must be a safe SemVer string.');
  }
  return version;
}

function copyExampleSchema(value, schema, label) {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value) || value.length !== schema.length) {
      throw new Error(`Example config ${label} must use its safe public default.`);
    }
    return schema.map((item, index) => copyExampleSchema(value[index], item, `${label}[${index}]`));
  }
  if (schema !== null && typeof schema === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Example config ${label} must contain a JSON object.`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema, key)) throw new Error(`Unknown field in example config ${label}.`);
    }
    const result = {};
    for (const key of Object.keys(schema)) {
      const field = label === 'root' ? key : `${label}.${key}`;
      if (!Object.hasOwn(value, key)) throw new Error(`Missing public example field: ${field}`);
      result[key] = copyExampleSchema(value[key], schema[key], field);
    }
    return result;
  }
  if (value !== schema) throw new Error(`Example config ${label} must use its safe public default.`);
  return schema;
}

function validateExample(example) {
  for (const field of EMPTY_EXAMPLE_FIELDS) {
    let value = example;
    for (const segment of field.split('.')) {
      value = value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, segment) ? value[segment] : undefined;
    }
    if (value !== '') {
      // Do not print the rejected value: it could contain a local secret.
      throw new Error(`Example config ${field} must be an empty string.`);
    }
  }
  return copyExampleSchema(example, EXAMPLE_SCHEMA, 'root');
}

function isWithin(parentDir, filename) {
  const relative = path.relative(parentDir, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function resolveOutputDirectory(rootDir, outputDir) {
  if (outputDir !== undefined && (typeof outputDir !== 'string' || !outputDir)) {
    throw new Error('outputDir must be a nonempty path within rootDir/dist.');
  }
  const distDir = path.join(rootDir, 'dist');
  const resolved = outputDir === undefined ? distDir : path.resolve(rootDir, outputDir);
  if (!isWithin(distDir, resolved)) {
    throw new Error('outputDir must stay within rootDir/dist.');
  }
  assertSafeFilename(path.relative(rootDir, resolved).split(path.sep).join('/'));
  return resolved;
}

function ensureOutputDirectory(rootDir, outputDir, create) {
  assertDirectory(rootDir, 'Release root');
  let current = rootDir;
  for (const segment of path.relative(rootDir, outputDir).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('Output directory must not contain symlinks.');
    if (!stat.isDirectory()) throw new Error('Output path must contain only directories.');
  }
}

function assertOutputFile(filename) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('Release destination must not be a symlink.');
  if (!stat.isFile()) throw new Error('Release destination must be a regular file.');
}

function crc32(data) {
  let crc = UINT32_MAX;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ UINT32_MAX) >>> 0;
}

function encodeZip(entries) {
  if (entries.length > 0xffff) throw new Error('Too many release files for ZIP32.');
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let localSize = 0;
  let centralSize = 0;

  for (const { name, data } of entries) {
    assertSafeFilename(name);
    const portableName = name.toLowerCase();
    if (seen.has(portableName)) throw new Error('Duplicate release filename.');
    seen.add(portableName);
    if (data.length > UINT32_MAX) throw new Error('Release input is too large for ZIP32.');
    const filename = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Fixed Unix origin and 0644 mode.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localSize, 42);

    localParts.push(local, filename, payload);
    centralParts.push(central, filename);
    localSize += local.length + filename.length + payload.length;
    centralSize += central.length + filename.length;
    if (localSize + centralSize + 22 > UINT32_MAX) {
      throw new Error('Release archive is too large for ZIP32.');
    }
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([...localParts, ...centralParts, end], localSize + centralSize + end.length);
}

function writeArchive(rootDir, outputDir, archivePath, archive) {
  ensureOutputDirectory(rootDir, outputDir, true);
  assertOutputFile(archivePath);
  // This fresh, private directory is the only cleanup target. Never delete
  // dist recursively or remove earlier releases.
  const temporaryDir = fs.mkdtempSync(path.join(outputDir, '.dsh-wecom-notify-release-'));
  const temporaryFile = path.join(temporaryDir, 'archive.zip');
  if (!isWithin(outputDir, temporaryDir) || !isWithin(temporaryDir, temporaryFile)) {
    throw new Error('Unsafe temporary release destination.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o644);
    fs.writeFileSync(descriptor, archive);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ensureOutputDirectory(rootDir, outputDir, false);
    assertDirectory(temporaryDir, 'Temporary release directory');
    assertOutputFile(archivePath);
    // Same-filesystem rename publishes the complete archive atomically.
    fs.renameSync(temporaryFile, archivePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    ensureOutputDirectory(rootDir, outputDir, false);
    assertDirectory(temporaryDir, 'Temporary release directory');
    try {
      fs.unlinkSync(temporaryFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.rmdirSync(temporaryDir);
  }
}

function buildRelease({ rootDir = path.resolve(__dirname, '..'), outputDir } = {}) {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir must be a nonempty directory path.');
  const root = path.resolve(rootDir);
  assertDirectory(root, 'Release root');
  const output = resolveOutputDirectory(root, outputDir);
  const entries = PUBLIC_FILES.map((name) => ({ name, data: readPublicFile(root, name) }));
  const files = new Map(entries.map(({ name, data }) => [name, data]));
  const version = validateManifest(parseObject(files.get('package.json'), 'package.json'));
  const exampleEntry = entries.find(({ name }) => name === 'dsh-wechat-config.example.json');
  const example = validateExample(parseObject(exampleEntry.data, 'example config'));
  // Raw input may contain discarded duplicate values or hidden metadata.
  // ZIP only the fresh schema-whitelisted representation, never those bytes.
  exampleEntry.data = Buffer.from(`${JSON.stringify(example, null, 2)}\n`, 'utf8');
  const archiveName = `${PROJECT_NAME}-v${version}.zip`;
  assertSafeFilename(archiveName);
  const archivePath = path.join(output, archiveName);
  if (!isWithin(output, archivePath)) throw new Error('Unsafe release destination.');
  const archive = encodeZip(entries);
  writeArchive(root, output, archivePath, archive);
  return { archivePath, version, fileCount: entries.length, bytes: archive.length };
}

module.exports = { buildRelease };

if (require.main === module) {
  try {
    const rootDir = path.resolve(__dirname, '..');
    // Optional CLI argument: an output directory inside rootDir/dist.
    const outputDir = process.argv[2];
    const result = buildRelease({ rootDir, outputDir });
    const displayPath = path.relative(rootDir, result.archivePath).split(path.sep).join('/');
    console.log(`Built ${displayPath} (${result.fileCount} files, ${result.bytes} bytes).`);
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  }
}
