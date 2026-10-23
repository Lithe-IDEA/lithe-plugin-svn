import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Verify vendored upstream inputs before testing or assembling a release. */
export async function verifySdk(root = repository) {
  const lock = JSON.parse(await readFile(join(root, 'sdk.lock.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(lock.source?.revision) || !Array.isArray(lock.files)) {
    throw new Error('sdk.lock.json must pin an exact upstream Git revision and file hashes.');
  }
  const expected = new Set();
  for (const entry of lock.files) {
    if (!entry.path?.startsWith('vendor/') || isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || entry.path.includes('\\') || !/^[0-9a-f]{64}$/.test(entry.sha256) || expected.has(entry.path)) {
      throw new Error('Invalid or duplicate SDK lock entry.');
    }
    expected.add(entry.path);
    const file = join(root, entry.path);
    if (!(await lstat(file)).isFile()) throw new Error(`SDK input is not a regular file: ${entry.path}`);
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual !== entry.sha256) throw new Error(`SDK SHA-256 mismatch: ${entry.path}`);
  }
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (!expected.delete(name)) throw new Error(`Unpinned SDK input: ${name}`);
    }
  }
  await walk(join(root, 'vendor'), 'vendor');
  if (expected.size) throw new Error('A pinned SDK input is missing.');
  return lock.source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Verified SDK from', await verifySdk());
}
