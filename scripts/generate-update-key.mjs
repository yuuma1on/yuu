#!/usr/bin/env node
import { createHash, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function mustNotExist(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Refusing to overwrite an existing key.');
}

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const option = process.argv[i];
    if (!['--private-key', '--public-key'].includes(option) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--') || options[option]) {
      throw new Error('Usage: node scripts/generate-update-key.mjs --private-key /outside/repository/private.pem [--public-key desktop/update-public-key.pem]');
    }
    options[option] = process.argv[i + 1];
  }
  if (!options['--private-key'] || !path.isAbsolute(options['--private-key'])) {
    throw new Error('--private-key must be an absolute path outside the repository.');
  }
  const privatePath = path.resolve(options['--private-key']);
  const publicPath = path.resolve(repositoryRoot, options['--public-key'] || 'desktop/update-public-key.pem');
  const canonicalRoot = await realpath(repositoryRoot);
  if (within(canonicalRoot, privatePath) || privatePath === publicPath) {
    throw new Error('The private key must remain outside the repository and separate from its public key.');
  }
  await mustNotExist(privatePath);
  await mustNotExist(publicPath);
  await mkdir(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(publicPath), { recursive: true });
  const canonicalPrivatePath = path.join(await realpath(path.dirname(privatePath)), path.basename(privatePath));
  if (within(canonicalRoot, canonicalPrivatePath)) throw new Error('The private key directory resolves inside the repository.');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
  } catch (error) {
    await unlink(privatePath);
    throw error;
  }
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  console.log(`SHA256:${fingerprint}`);
}

main().catch((error) => {
  console.error(error.code ? 'Key generation failed; check destination paths and permissions.' : error.message);
  process.exitCode = 1;
});
