import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { buildPackage, pluginID } from '../scripts/package.mjs';
import { repository, verifySdk } from '../scripts/verify-sdk.mjs';

async function files(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.push(relative(root, path));
    }
  }
  await walk(root);
  return result.sort();
}

test('SDK integrity rejects changed and unpinned vendored files', { timeout: 5000 }, async (t) => {
  await verifySdk();
  const root = await mkdtemp(join(tmpdir(), 'lithe-svn-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repository, 'vendor'), join(root, 'vendor'), { recursive: true });
  await cp(join(repository, 'sdk.lock.json'), join(root, 'sdk.lock.json'));
  const lock = JSON.parse(await readFile(join(root, 'sdk.lock.json')));
  const file = join(root, lock.files[0].path);
  const original = await readFile(file);
  await writeFile(file, 'changed SDK');
  await assert.rejects(verifySdk(root), /SHA-256 mismatch/);
  await writeFile(file, original);
  await writeFile(join(root, 'vendor/unpinned.mjs'), '');
  await assert.rejects(verifySdk(root), /Unpinned SDK input/);
});

test('the package holds the provider, the SDK runtime and the notices, and nothing for tests', { timeout: 15000 }, async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'lithe-svn-package-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const { directory, archive, sha256 } = await buildPackage(output);
  assert.equal(directory, join(output, pluginID));
  const sdk = (await readdir(join(repository, 'vendor/lithe-plugin-sdk/src'))).filter((name) => name.endsWith('.mjs'));
  assert.deepEqual(await files(directory), [
    'LICENSE',
    'NOTICE',
    'README.md',
    'plugin.json',
    'provider/svn-output.mjs',
    'provider/svn-provider.mjs',
    ...sdk.map((name) => `provider/vendor/lithe-plugin-sdk/${name}`),
    'provider/xml.mjs',
  ].sort());
  const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'));
  assert.equal(archive, join(output, `svn-support-${manifest.version}-darwin.zip`));
  assert.match(await readFile(`${archive}.sha256`, 'utf8'), new RegExp(`^${sha256}  svn-support-`));
});

test('a release cannot package a tag that disagrees with the manifest', { timeout: 5000 }, async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'lithe-svn-package-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await assert.rejects(buildPackage(output, 'v9.9.9'), /release tag/);
});
