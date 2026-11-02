'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { buildRelease } = require('../scripts/build-release.js');

// Independent expectation: an accidental builder allowlist change must fail.
const EXPECTED_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
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
].sort();
const EMPTY_FIELDS = [
  'wecomWebhook', 'pushplus.token', 'serverchan.sendKey', 'aibot.botId',
  'aibot.secret', 'sessionsRoot', 'aibot.chatFile', 'harnessExecutable',
];
const PRIVATE_MARKER = ['PRIVATE', 'MARKER', 'fixture-only'].join('_');
const FORBIDDEN_FILES = [
  'dsh-wechat-config.json',
  'dsh-wechat-notify.state.json',
  'dsh-wechat-notify.log',
  'state/local.json',
  'logs/notifier.log',
  'sessions/chat.json',
  'chat/private.jsonl',
  '.runtime/state.json',
  'node_modules/ws/index.js',
  '.wsdeps/node_modules/ws/index.js',
  '.git/config',
  'dist/stale.zip',
  'private.txt',
];

function emptyExample() {
  return {
    transport: 'webhook',
    wecomWebhook: '',
    pushplus: { token: '', template: 'markdown', channel: 'wechat' },
    serverchan: { sendKey: '' },
    aibot: { botId: '', secret: '', chatFile: '' },
    sessionsRoot: '',
    pollMs: 2000,
    notifyOn: ['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens'],
    mention: '',
    maxTextChars: 220,
    lockPort: 39271,
    requireHarness: true,
    harnessPort: 0,
    harnessProcess: 'DeepSeek Harness.exe',
    harnessExecutable: '',
  };
}

function exampleJson() {
  return `${JSON.stringify(emptyExample(), null, 2)}\n`;
}

function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const sandbox = fs.mkdtempSync(path.join(temporaryRoot, 'dsh-release-test-'));
  // Only this newly created, verified temporary tree is ever removed.
  assert.equal(path.dirname(sandbox), temporaryRoot);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  const expected = new Map();
  const filename = (name) => {
    const resolved = path.resolve(root, ...name.split('/'));
    const relative = path.relative(root, resolved);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
    return resolved;
  };
  const put = (name, contents) => {
    const destination = filename(name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    fs.writeFileSync(destination, buffer);
    if (EXPECTED_FILES.includes(name)) expected.set(name, buffer);
    return destination;
  };
  for (const name of EXPECTED_FILES) put(name, `Public fixture: ${name}\n`);
  put('README.md', 'Public UTF-8 fixture: 你好 🌐\n'.repeat(20));
  put('package.json', JSON.stringify({ name: 'dsh-wecom-notify', version: '0.1.0' }, null, 2));
  put('dsh-wechat-config.example.json', exampleJson());
  for (const name of FORBIDDEN_FILES) put(name, PRIVATE_MARKER);
  return { root, sandbox, expected, filename, put };
}

function releasePath(root, version = '0.1.0') {
  return path.join(root, 'dist', `dsh-wecom-notify-v${version}.zip`);
}

// Independent bit-at-a-time CRC rather than sharing the builder's table.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  assert.ok(buffer.length >= 22);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, 'ZIP end record');
  assert.equal(buffer.readUInt16LE(end + 4), 0, 'single disk');
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  assert.equal(buffer.readUInt16LE(end + 20), 0, 'no archive comment');
  const count = buffer.readUInt16LE(end + 10);
  assert.equal(buffer.readUInt16LE(end + 8), count);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  assert.equal(centralOffset + centralSize, end);
  const entries = [];
  let position = centralOffset;
  let nextLocal = 0;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, 'central directory record');
    assert.equal(buffer.readUInt16LE(position + 6), 20, 'ZIP version');
    const flags = buffer.readUInt16LE(position + 8);
    assert.equal(flags, 0x0800, 'UTF-8, no encryption or data descriptors');
    const method = buffer.readUInt16LE(position + 10);
    assert.ok(method === 0 || method === 8, 'store or raw deflate');
    const time = buffer.readUInt16LE(position + 12);
    const date = buffer.readUInt16LE(position + 14);
    const checksum = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const originalSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    assert.equal(buffer.readUInt16LE(position + 30), 0, 'no extra fields');
    assert.equal(buffer.readUInt16LE(position + 32), 0, 'no member comments');
    assert.equal(buffer.readUInt16LE(position + 34), 0);
    assert.equal(buffer.readUInt32LE(position + 38), (0o100644 << 16) >>> 0);
    const localOffset = buffer.readUInt32LE(position + 42);
    assert.equal(localOffset, nextLocal, 'no unlisted local records or data');
    const nameBytes = buffer.subarray(position + 46, position + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    assert.deepEqual(Buffer.from(name, 'utf8'), nameBytes);
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'));

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'local file header');
    assert.equal(buffer.readUInt16LE(localOffset + 4), 20);
    assert.equal(buffer.readUInt16LE(localOffset + 6), flags);
    assert.equal(buffer.readUInt16LE(localOffset + 8), method);
    assert.equal(buffer.readUInt16LE(localOffset + 10), time);
    assert.equal(buffer.readUInt16LE(localOffset + 12), date);
    assert.equal(buffer.readUInt32LE(localOffset + 14), checksum);
    assert.equal(buffer.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(buffer.readUInt32LE(localOffset + 22), originalSize);
    assert.equal(buffer.readUInt16LE(localOffset + 26), nameLength);
    assert.equal(buffer.readUInt16LE(localOffset + 28), 0);
    assert.deepEqual(buffer.subarray(localOffset + 30, localOffset + 30 + nameLength), nameBytes);
    const dataStart = localOffset + 30 + nameLength;
    nextLocal = dataStart + compressedSize;
    assert.ok(nextLocal <= centralOffset);
    const payload = buffer.subarray(dataStart, nextLocal);
    const contents = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(contents.length, originalSize);
    assert.equal(crc32(contents), checksum, `CRC32 for ${name}`);
    entries.push({ name, contents, method, time, date });
    position += 46 + nameLength;
  }
  assert.equal(nextLocal, centralOffset);
  assert.equal(position, end);
  assert.equal(new Set(entries.map(({ name }) => name)).size, count);
  return entries;
}

function symlink(t, target, link, directory = false) {
  try {
    fs.symlinkSync(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('OS does not permit this symlink type');
    return false;
  }
}

test('release contains only exact public inputs and valid ZIP records', (t) => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const f = fixture(t);
  const result = buildRelease({ rootDir: f.root });
  assert.equal(result.archivePath, releasePath(f.root));
  assert.equal(result.version, '0.1.0');
  assert.equal(result.fileCount, EXPECTED_FILES.length);
  const archive = fs.readFileSync(result.archivePath);
  assert.equal(result.bytes, archive.length);
  const entries = readZip(archive);
  assert.deepEqual(entries.map(({ name }) => name), EXPECTED_FILES);
  for (const entry of entries) {
    assert.deepEqual(entry.contents, f.expected.get(entry.name));
    assert.equal(entry.contents.includes(Buffer.from(PRIVATE_MARKER)), false);
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 0x0021);
    assert.ok(!/^(?:node_modules|\.wsdeps|dist|\.git|logs|state|sessions|chat|\.runtime)(?:\/|$)/u.test(entry.name));
  }
  assert.equal(entries.some(({ name }) => name === 'dsh-wechat-config.json'), false);
  assert.ok(entries.some(({ method }) => method === 8));
  assert.equal(fs.readFileSync(f.filename('dist/stale.zip'), 'utf8'), PRIVATE_MARKER);
});

test('release bytes are stable across source timestamps and atomic replacement', (t) => {
  const f = fixture(t);
  const first = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  for (const name of EXPECTED_FILES) {
    fs.utimesSync(f.filename(name), new Date('2001-01-01T00:00:00Z'), new Date('2030-06-01T00:00:00Z'));
  }
  const second = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  assert.deepEqual(second, first);
  assert.deepEqual(fs.readdirSync(f.filename('dist')).sort(), ['dsh-wecom-notify-v0.1.0.zip', 'stale.zip']);
});

test('allows nested dist output and safe SemVer prerelease/build metadata', (t) => {
  const f = fixture(t);
  const version = '1.2.3-rc.1+build.7';
  f.put('package.json', JSON.stringify({ name: 'dsh-wecom-notify', version }));
  const outputDir = path.join(f.root, 'dist', 'releases');
  const result = buildRelease({ rootDir: f.root, outputDir });
  assert.equal(result.archivePath, path.join(outputDir, `dsh-wecom-notify-v${version}.zip`));
  assert.equal(readZip(fs.readFileSync(result.archivePath)).length, EXPECTED_FILES.length);
  const relativeResult = buildRelease({ rootDir: f.root, outputDir: 'dist/relative' });
  assert.equal(path.dirname(relativeResult.archivePath), path.join(f.root, 'dist', 'relative'));
});

function assertRejectedExample(t, raw, expectedError) {
  const f = fixture(t);
  const previous = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  assert.ok(raw.includes(PRIVATE_MARKER), 'attack fixture contains synthetic private data');
  f.put('dsh-wechat-config.example.json', raw);
  assert.throws(() => buildRelease({ rootDir: f.root }), (error) => {
    assert.match(error.message, expectedError);
    assert.equal(error.message.includes(PRIVATE_MARKER), false);
    return true;
  });
  const retained = fs.readFileSync(releasePath(f.root));
  assert.deepEqual(retained, previous, 'rejected input does not replace a clean release');
  for (const { contents } of readZip(retained)) {
    assert.equal(contents.includes(Buffer.from(PRIVATE_MARKER)), false);
  }
}

test('rejects duplicate and escaped duplicate example keys before archiving raw secrets', async (t) => {
  for (const field of EMPTY_FIELDS) {
    for (const escaped of [false, true]) {
      await t.test(`${field}: ${escaped ? 'escaped' : 'literal'} duplicate`, (child) => {
        const key = field.split('.').at(-1);
        const literalKey = JSON.stringify(key);
        const duplicateKey = escaped
          ? `"\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}"` : literalKey;
        const needle = `${literalKey}:""`;
        const clean = JSON.stringify(emptyExample());
        assert.ok(clean.includes(needle));
        const raw = clean.replace(needle, `${literalKey}:${JSON.stringify(PRIVATE_MARKER)},${duplicateKey}:""`);
        assertRejectedExample(child, raw, /Duplicate JSON key/u);
      });
    }
  }
  await t.test('duplicate provider object', (child) => {
    const first = JSON.stringify({ token: PRIVATE_MARKER, template: 'markdown', channel: 'wechat' });
    const raw = JSON.stringify(emptyExample()).replace('"pushplus":', `"pushplus":${first},"pushplus":`);
    assertRejectedExample(child, raw, /Duplicate JSON key/u);
  });
  await t.test('two escaped spellings decode to the same key', (child) => {
    const raw = JSON.stringify(emptyExample()).replace('"wecomWebhook":""',
      `"\\u0077ecomWebhook":${JSON.stringify(PRIVATE_MARKER)},"wecom\\u0057ebhook":""`);
    assertRejectedExample(child, raw, /Duplicate JSON key/u);
  });
});

test('rejects unknown root and provider fields, including private property names', async (t) => {
  const changes = [
    ['root', (config) => { config.privateMemo = PRIVATE_MARKER; }],
    ['pushplus', (config) => { config.pushplus.privateMemo = PRIVATE_MARKER; }],
    ['serverchan', (config) => { config.serverchan.localState = { data: PRIVATE_MARKER }; }],
    ['aibot', (config) => { config.aibot.localLog = PRIVATE_MARKER; }],
    ['private key name', (config) => { config[PRIVATE_MARKER] = ''; }],
    ['inherited-looking key', (config) => { config.constructor = PRIVATE_MARKER; }],
    ['prototype key', (config) => {
      Object.defineProperty(config, '__proto__', { value: PRIVATE_MARKER, enumerable: true });
    }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, (child) => {
      const config = emptyExample();
      change(config);
      assertRejectedExample(child, JSON.stringify(config), /Unknown field/u);
    });
  }
});

test('known non-credential fields cannot carry private values', async (t) => {
  const changes = [
    ['transport', (config) => { config.transport = PRIVATE_MARKER; }],
    ['mention', (config) => { config.mention = PRIVATE_MARKER; }],
    ['harnessProcess', (config) => { config.harnessProcess = PRIVATE_MARKER; }],
    ['pushplus.template', (config) => { config.pushplus.template = PRIVATE_MARKER; }],
    ['pushplus.channel', (config) => { config.pushplus.channel = PRIVATE_MARKER; }],
    ['notifyOn', (config) => { config.notifyOn = [PRIVATE_MARKER]; }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, (child) => {
      const config = emptyExample();
      change(config);
      assertRejectedExample(child, JSON.stringify(config), /safe public default/u);
    });
  }
});

test('archives only freshly serialized whitelisted examples, independent of raw formatting', (t) => {
  const f = fixture(t);
  const first = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  const reverseKeys = (value) => {
    if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  };
  const raw = `\r\n ${JSON.stringify(reverseKeys(emptyExample()), null, '\t')}\r\n\t`
    .replace('"wecomWebhook"', '"\\u0077ecomWebhook"');
  assert.notEqual(raw, exampleJson());
  f.put('dsh-wechat-config.example.json', raw);
  const second = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  assert.deepEqual(second, first);
  const entries = readZip(second);
  const example = entries.find(({ name }) => name === 'dsh-wechat-config.example.json');
  assert.equal(example.contents.toString('utf8'), exampleJson());
  assert.notEqual(example.contents.toString('utf8'), raw);
  for (const { contents } of entries) assert.equal(contents.includes(Buffer.from(PRIVATE_MARKER)), false);
});

test('refuses every missing public input', async (t) => {
  for (const name of EXPECTED_FILES) {
    await t.test(name, (child) => {
      const f = fixture(child);
      fs.unlinkSync(f.filename(name));
      assert.throws(() => buildRelease({ rootDir: f.root }), /Missing public file/u);
      assert.equal(fs.existsSync(releasePath(f.root)), false);
    });
  }
});

test('refuses nonempty example credentials and machine-specific paths', async (t) => {
  for (const field of EMPTY_FIELDS) {
    await t.test(field, (child) => {
      const f = fixture(child);
      const config = emptyExample();
      const segments = field.split('.');
      const key = segments.pop();
      let parent = config;
      for (const segment of segments) parent = parent[segment];
      parent[key] = PRIVATE_MARKER;
      f.put('dsh-wechat-config.example.json', JSON.stringify(config));
      f.put('dist/dsh-wecom-notify-v0.1.0.zip', 'previous release');
      assert.throws(() => buildRelease({ rootDir: f.root }), (error) => {
        assert.ok(error.message.includes(`${field} must be an empty string`));
        assert.equal(error.message.includes(PRIVATE_MARKER), false);
        return true;
      });
      assert.equal(fs.readFileSync(releasePath(f.root), 'utf8'), 'previous release');
    });
  }
});

test('refuses missing, whitespace-only and non-string example fields', async (t) => {
  const changes = [
    (config) => { delete config.wecomWebhook; },
    (config) => { config.pushplus = null; },
    (config) => { config.serverchan.sendKey = false; },
    (config) => { config.aibot.secret = 0; },
    (config) => { config.sessionsRoot = ' '; },
    (config) => { config.aibot.chatFile = []; },
    (config) => { delete config.aibot.chatFile; config.chatFile = ''; },
    (config) => { delete config.harnessExecutable; },
  ];
  for (const [index, change] of changes.entries()) {
    await t.test(`invalid field case ${index + 1}`, (child) => {
      const f = fixture(child);
      const config = emptyExample();
      change(config);
      f.put('dsh-wechat-config.example.json', JSON.stringify(config));
      assert.throws(() => buildRelease({ rootDir: f.root }), /must be an empty string/u);
    });
  }
});

test('rejects unsafe or unexpected manifest names and unsafe versions', async (t) => {
  const invalidNames = ['../private', 'dsh-wecom-notify/other', 'dsh-wecom-notify\\other', '@scope/project', 'CON', '', null];
  const invalidVersions = [
    '../../private', '0.1.0/../private', '0.1.0\\private', '0.1.0\n', '0.1.0\0',
    '01.1.0', '0.1', '0.1.0-01', '0.1.0+..', '0.1.0.', '', null, 1,
  ];
  for (const [field, values] of [['name', invalidNames], ['version', invalidVersions]]) {
    for (const [index, value] of values.entries()) {
      await t.test(`${field} case ${index + 1}`, (child) => {
        const f = fixture(child);
        const manifest = { name: 'dsh-wecom-notify', version: '0.1.0', [field]: value };
        f.put('package.json', JSON.stringify(manifest));
        assert.throws(() => buildRelease({ rootDir: f.root }), field === 'name' ? /name must/u : /safe SemVer/u);
        assert.equal(fs.existsSync(releasePath(f.root)), false);
      });
    }
  }
});

test('rejects malformed JSON and non-object manifests/examples', async (t) => {
  for (const name of ['package.json', 'dsh-wechat-config.example.json']) {
    for (const contents of ['{', 'null', '[]']) {
      await t.test(`${name}: ${contents}`, (child) => {
        const f = fixture(child);
        f.put(name, contents);
        assert.throws(() => buildRelease({ rootDir: f.root }), /Invalid JSON|JSON object/u);
      });
    }
  }
});

test('rejects output outside dist without touching unrelated files', async (t) => {
  for (const selection of ['.', '..', '../outside', 'dist/../../outside', 'dist-other']) {
    await t.test(selection, (child) => {
      const f = fixture(child);
      const sentinel = path.join(f.sandbox, 'keep.txt');
      fs.writeFileSync(sentinel, PRIVATE_MARKER);
      assert.throws(() => buildRelease({ rootDir: f.root, outputDir: selection }), /within rootDir\/dist/u);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), PRIVATE_MARKER);
      assert.equal(fs.existsSync(releasePath(f.root)), false);
    });
  }
  await t.test('absolute outside directory', (child) => {
    const f = fixture(child);
    const outside = path.join(f.sandbox, 'outside');
    fs.mkdirSync(outside);
    assert.throws(() => buildRelease({ rootDir: f.root, outputDir: outside }), /within rootDir\/dist/u);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

test('rejects non-directory public inputs and invalid path arguments', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.filename('README.md'));
  fs.mkdirSync(f.filename('README.md'));
  assert.throws(() => buildRelease({ rootDir: f.root }), /regular file/u);
  for (const value of ['', null, 1, []]) {
    assert.throws(() => buildRelease({ rootDir: value }), /rootDir must/u);
    assert.throws(() => buildRelease({ rootDir: f.root, outputDir: value }), /outputDir must/u);
  }
});

test('rejects symlinks in public inputs and their parents when supported', async (t) => {
  await t.test('public file symlink', (child) => {
    const f = fixture(child);
    const target = path.join(f.sandbox, 'private-file.txt');
    fs.writeFileSync(target, PRIVATE_MARKER);
    fs.unlinkSync(f.filename('README.md'));
    if (!symlink(child, target, f.filename('README.md'))) return;
    assert.throws(() => buildRelease({ rootDir: f.root }), /symlink/u);
    assert.equal(fs.readFileSync(target, 'utf8'), PRIVATE_MARKER);
  });
  await t.test('public parent directory symlink', (child) => {
    const f = fixture(child);
    const target = path.join(f.sandbox, 'linked-scripts');
    fs.renameSync(f.filename('scripts'), target);
    if (!symlink(child, target, f.filename('scripts'), true)) return;
    assert.throws(() => buildRelease({ rootDir: f.root }), /symlink/u);
  });
  await t.test('release root symlink', (child) => {
    const f = fixture(child);
    const link = path.join(f.sandbox, 'project-link');
    if (!symlink(child, f.root, link, true)) return;
    assert.throws(() => buildRelease({ rootDir: link }), /symlink/u);
  });
});

function hardlink(t, target, link) {
  try {
    fs.linkSync(target, link);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EXDEV'].includes(error.code)) throw error;
    t.skip('OS does not permit hard links here');
    return false;
  }
}

test('rejects public hard links to synthetic private fixture data', (t) => {
  const f = fixture(t);
  const previous = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  const privateFile = path.join(f.sandbox, 'private-source.txt');
  fs.writeFileSync(privateFile, PRIVATE_MARKER);
  fs.unlinkSync(f.filename('README.md'));
  if (!hardlink(t, privateFile, f.filename('README.md'))) return;
  assert.ok(fs.lstatSync(f.filename('README.md')).nlink > 1);
  assert.throws(() => buildRelease({ rootDir: f.root }), /hard link/u);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), PRIVATE_MARKER);
  const retained = fs.readFileSync(releasePath(f.root));
  assert.deepEqual(retained, previous);
  for (const { contents } of readZip(retained)) assert.equal(contents.includes(Buffer.from(PRIVATE_MARKER)), false);
});

test('fstat rejects hard links introduced after lstat and before content reads', (t) => {
  const f = fixture(t);
  const previous = fs.readFileSync(buildRelease({ rootDir: f.root }).archivePath);
  const publicFile = f.filename('README.md');
  const addedLink = path.join(f.sandbox, 'added-link.txt');
  if (!hardlink(t, publicFile, addedLink)) return;
  fs.unlinkSync(addedLink);
  f.put('README.md', PRIVATE_MARKER);
  assert.equal(fs.lstatSync(publicFile).nlink, 1);
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  let introduced = false;
  let blockedDescriptor;
  try {
    fs.openSync = function (...args) {
      const isTarget = typeof args[0] === 'string' && path.resolve(args[0]) === publicFile;
      if (isTarget && !introduced) {
        fs.linkSync(publicFile, addedLink);
        introduced = true;
      }
      const descriptor = originalOpen.apply(this, args);
      if (isTarget) blockedDescriptor = descriptor;
      return descriptor;
    };
    fs.readFileSync = function (...args) {
      if (args[0] === blockedDescriptor) throw new Error('Hard-linked fixture data must never be read.');
      return originalRead.apply(this, args);
    };
    assert.throws(() => buildRelease({ rootDir: f.root }), /hard link/u);
    assert.equal(introduced, true);
  } finally {
    fs.openSync = originalOpen;
    fs.readFileSync = originalRead;
  }
  const retained = fs.readFileSync(releasePath(f.root));
  assert.deepEqual(retained, previous);
  for (const { contents } of readZip(retained)) assert.equal(contents.includes(Buffer.from(PRIVATE_MARKER)), false);
});

test('build never opens or reads forbidden fixture configuration, state, chats or logs', (t) => {
  const f = fixture(t);
  const keyOf = (filename) => {
    const resolved = path.resolve(filename);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const allowed = new Set(EXPECTED_FILES.map((name) => keyOf(f.filename(name))));
  const forbidden = new Set(FORBIDDEN_FILES.map((name) => keyOf(f.filename(name))));
  const descriptors = new Map();
  const openedInputs = [];
  const readInputs = [];
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  let result;
  try {
    fs.openSync = function (...args) {
      const filename = typeof args[0] === 'string' ? keyOf(args[0]) : undefined;
      const flags = args[1];
      const canRead = typeof flags === 'number'
        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== fs.constants.O_WRONLY
        : typeof flags === 'string' && (flags.startsWith('r') || flags.includes('+'));
      if (canRead) {
        assert.ok(filename && allowed.has(filename) && !forbidden.has(filename),
          'Builder attempted to open a forbidden or non-allowlisted input.');
        openedInputs.push(filename);
      }
      const descriptor = originalOpen.apply(this, args);
      descriptors.set(descriptor, filename);
      return descriptor;
    };
    fs.readFileSync = function (...args) {
      const filename = typeof args[0] === 'number' ? descriptors.get(args[0])
        : typeof args[0] === 'string' ? keyOf(args[0]) : undefined;
      assert.ok(filename && allowed.has(filename) && !forbidden.has(filename),
        'Builder attempted to read forbidden configuration, state, chats or logs.');
      readInputs.push(filename);
      return originalRead.apply(this, args);
    };
    result = buildRelease({ rootDir: f.root });
  } finally {
    fs.openSync = originalOpen;
    fs.readFileSync = originalRead;
  }
  assert.deepEqual(openedInputs.sort(), [...allowed].sort());
  assert.deepEqual(readInputs.sort(), [...allowed].sort());
  for (const { contents } of readZip(fs.readFileSync(result.archivePath))) {
    assert.equal(contents.includes(Buffer.from(PRIVATE_MARKER)), false);
  }
});

test('rejects output directory and destination symlinks when supported', async (t) => {
  for (const nested of [false, true]) {
    await t.test(nested ? 'nested directory symlink' : 'dist directory symlink', (child) => {
      const f = fixture(child);
      const outside = path.join(f.sandbox, 'outside');
      fs.mkdirSync(outside);
      const sentinel = path.join(outside, 'keep.txt');
      fs.writeFileSync(sentinel, PRIVATE_MARKER);
      const outputDir = nested ? f.filename('dist/nested') : f.filename('dist');
      if (!nested) fs.renameSync(outputDir, path.join(f.sandbox, 'old-dist'));
      if (!symlink(child, outside, outputDir, true)) return;
      assert.throws(() => buildRelease({ rootDir: f.root, outputDir }), /symlink/u);
      assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), PRIVATE_MARKER);
    });
  }
  await t.test('archive destination symlink', (child) => {
    const f = fixture(child);
    const target = path.join(f.sandbox, 'private-file.txt');
    fs.writeFileSync(target, PRIVATE_MARKER);
    if (!symlink(child, target, releasePath(f.root))) return;
    assert.throws(() => buildRelease({ rootDir: f.root }), /symlink/u);
    assert.equal(fs.readFileSync(target, 'utf8'), PRIVATE_MARKER);
  });
  await t.test('archive destination directory', (child) => {
    const f = fixture(child);
    fs.mkdirSync(releasePath(f.root));
    assert.throws(() => buildRelease({ rootDir: f.root }), /regular file/u);
  });
});

test('CLI reports success and nonzero failures using only isolated fixtures', (t) => {
  const f = fixture(t);
  // Copy only this public builder, never the working tree's local config/data.
  f.put('scripts/build-release.js', fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-release.js')));
  const run = () => spawnSync(process.execPath, [f.filename('scripts/build-release.js')], {
    cwd: f.root, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  const success = run();
  assert.equal(success.error, undefined);
  assert.equal(success.status, 0);
  assert.match(success.stdout, /^Built dist\/dsh-wecom-notify-v0\.1\.0\.zip \(16 files, \d+ bytes\)\./u);
  assert.equal(success.stderr, '');
  const previous = fs.readFileSync(releasePath(f.root));
  const config = emptyExample();
  config.aibot.secret = PRIVATE_MARKER;
  f.put('dsh-wechat-config.example.json', JSON.stringify(config));
  const failure = run();
  assert.equal(failure.error, undefined);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /^Release failed: Example config aibot\.secret must be an empty string\./u);
  assert.equal(failure.stderr.includes(PRIVATE_MARKER), false);
  assert.equal(failure.stdout, '');
  assert.deepEqual(fs.readFileSync(releasePath(f.root)), previous);
});

test('CLI accepts an output directory inside dist and rejects one outside it', (t) => {
  const f = fixture(t);
  f.put('scripts/build-release.js', fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-release.js')));
  const run = (outputDir) => spawnSync(process.execPath, [f.filename('scripts/build-release.js'), outputDir], {
    cwd: f.root, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  const inside = run('dist/ci');
  assert.equal(inside.status, 0);
  assert.match(inside.stdout, /^Built dist\/ci\/dsh-wecom-notify-v0\.1\.0\.zip \(16 files, \d+ bytes\)\./u);
  assert.equal(fs.existsSync(path.join(f.root, 'dist', 'ci', 'dsh-wecom-notify-v0.1.0.zip')), true);
  const outside = run('..');
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /^Release failed: outputDir must stay within rootDir\/dist\./u);
});
