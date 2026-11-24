#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--dir', '--key', '--version'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[name]) {
      fail('Usage: node scripts/sign-update.mjs [--dir dist] [--version 1.26.0] [--key /outside/repository/private.pem]');
    }
    options[name] = argv[i + 1];
  }
  return options;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ordinaryFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size <= 0) {
    fail(`Expected a nonempty regular file: ${path.basename(filename)}`);
  }
  return info;
}

async function sha512(filename) {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('base64');
}

function sameHash(actual, expected) {
  if (typeof actual !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(actual)) return false;
  const bytes = Buffer.from(actual, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === actual && timingSafeEqual(bytes, Buffer.from(expected, 'base64'));
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (typeof version !== 'string' || !stableVersion.test(version)) fail('package.json must contain a stable, canonical semantic version.');
  if (options['--version'] && options['--version'] !== version) fail('Requested release version does not match package.json.');

  const releaseDirectory = path.resolve(repositoryRoot, options['--dir'] || 'dist');
  const installerName = `PULSE-Setup-${version}-x64.exe`;
  const installerPath = path.join(releaseDirectory, installerName);
  const latestPath = path.join(releaseDirectory, 'latest.yml');
  const outputPath = path.join(releaseDirectory, 'pulse-update.json');
  const entries = await readdir(releaseDirectory);
  if (entries.filter((name) => /\.exe$/i.test(name)).length !== 1 || !entries.includes(installerName)) {
    fail('The release directory must contain exactly the expected x64 full NSIS installer.');
  }
  if (entries.some((name) => /\.blockmap$/i.test(name) && name !== `${installerName}.blockmap`)) {
    fail('The release directory contains an unexpected blockmap.');
  }
  const installerInfo = await ordinaryFile(installerPath);
  const latestInfo = await ordinaryFile(latestPath);
  if (latestInfo.size > 1024 * 1024) fail('latest.yml is unexpectedly large.');
  const latestBytes = await readFile(latestPath);
  const document = parseDocument(latestBytes.toString('utf8'), { uniqueKeys: true, schema: 'core' });
  if (document.errors.length || document.warnings.length) fail('latest.yml is not unambiguous standard YAML.');
  let latest;
  try {
    latest = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail('YAML aliases are not permitted in latest.yml.');
  }
  if (!plainObject(latest) || latest.version !== version || latest.path !== installerName ||
      !Array.isArray(latest.files) || latest.files.length !== 1 ||
      Object.hasOwn(latest, 'packages') || Object.hasOwn(latest, 'packageFiles')) {
    fail('latest.yml must describe only the matching full NSIS installer and version.');
  }
  const file = latest.files[0];
  if (!plainObject(file) || file.url !== installerName || file.size !== installerInfo.size ||
      !Number.isSafeInteger(file.size) || (Object.hasOwn(latest, 'size') && latest.size !== installerInfo.size)) {
    fail('latest.yml installer name or size does not match the built installer.');
  }
  const installerHash = await sha512(installerPath);
  if (!sameHash(file.sha512, installerHash) || !sameHash(latest.sha512, installerHash)) {
    fail('latest.yml SHA-512 does not match the built installer.');
  }

  const environmentKey = process.env.PULSE_UPDATE_PRIVATE_KEY;
  if (environmentKey && options['--key']) fail('Provide a private key through exactly one source.');
  let privatePem = environmentKey;
  if (options['--key']) {
    if (!path.isAbsolute(options['--key'])) fail('--key must be an absolute path outside the repository.');
    const privatePath = await realpath(options['--key']);
    if (within(await realpath(repositoryRoot), privatePath)) fail('Private keys must remain outside the repository.');
    await ordinaryFile(options['--key']);
    privatePem = await readFile(privatePath, 'utf8');
  }
  if (!privatePem) fail('Missing PULSE_UPDATE_PRIVATE_KEY or --key.');
  let privateKey;
  try {
    privateKey = createPrivateKey(privatePem);
  } catch {
    fail('The supplied update signing key could not be loaded.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('The update signing key must use Ed25519.');
  let trustedPublicKey;
  try {
    trustedPublicKey = createPublicKey(await readFile(path.join(repositoryRoot, 'desktop/update-public-key.pem')));
  } catch {
    fail('The committed update public key could not be loaded.');
  }
  const expectedPublicDer = trustedPublicKey.export({ type: 'spki', format: 'der' });
  const actualPublicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (trustedPublicKey.asymmetricKeyType !== 'ed25519' || expectedPublicDer.length !== actualPublicDer.length ||
      !timingSafeEqual(expectedPublicDer, actualPublicDer)) {
    fail('The signing key does not match the committed update public key.');
  }

  const payload = {
    schemaVersion: 1,
    appId: 'app.pulse.rhythmstudio',
    repository: 'yuuma1on/yuu',
    channel: 'stable',
    platform: 'win32',
    arch: 'x64',
    version,
    publishedAt: new Date().toISOString(),
    installer: {
      name: installerName,
      size: installerInfo.size,
      sha512: installerHash,
      url: `https://github.com/yuuma1on/yuu/releases/download/v${version}/${installerName}`,
    },
    latestYml: {
      name: 'latest.yml',
      size: latestBytes.length,
      sha512: createHash('sha512').update(latestBytes).digest('base64'),
    },
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope = {
    payload: payloadBytes.toString('base64'),
    signature: sign(null, payloadBytes, privateKey).toString('base64'),
  };
  // Refuse overwrite so stale or partially retried release preparation is visible.
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  console.log(`Signed pulse-update.json for PULSE ${version}.`);
}

main().catch((error) => {
  // Crypto parsing errors can contain key input; expose only our controlled messages.
  const safe = error instanceof Error && !error.code ? error.message : 'Release signing failed; check input files and output permissions.';
  console.error(safe);
  process.exitCode = 1;
});
