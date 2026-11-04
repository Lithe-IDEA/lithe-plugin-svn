import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../vendor/lithe-plugin-sdk/src/index.mjs';
import { repository } from './verify-sdk.mjs';

export const target = join(repository, '.artifacts/core-target');
export const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
export async function git(source, args) {
  const result = await runProcess('git', ['-C', source, ...args], { signal: AbortSignal.timeout(15000), maxOutputBytes: 8 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.truncated) throw new Error(`Core source verification failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A source identity includes dirty bytes only when the caller explicitly opted in. */
export async function identifyCore(source, ref, workingTree, expectedRepository) {
  const remote = (await git(source, ['remote', 'get-url', 'origin'])).replace(/\.git$/, '');
  if (remote !== expectedRepository) throw new Error('Core source has an unexpected origin repository.');
  const revision = await git(source, ['rev-parse', 'HEAD']);
  if (revision !== await git(source, ['rev-parse', `${ref}^{commit}`])) throw new Error('Core source HEAD does not match the explicitly selected ref.');
  const dirty = Boolean(await git(source, ['status', '--porcelain', '--untracked-files=normal', '--', 'rust', 'shared']));
  if (dirty && !workingTree) throw new Error('Core source is dirty; explicitly select --working-tree for local validation.');
  const paths = (await git(source, ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'rust', 'shared'])).split('\n').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)]) {
    hash.update(path + '\n');
    try { hash.update(await readFile(join(source, path))); }
    catch (error) { if (error.code === 'ENOENT') hash.update('<deleted>'); else throw error; }
  }
  const catalog = JSON.parse(await readFile(join(source, 'shared/logging/events/plugins.json'), 'utf8'));
  if (!catalog.events.some((event) => event.id === 'plugins.operation.finished')) {
    throw new Error('Selected Core lacks litheLogging:1. Merge the companion host logging change into preview first.');
  }
  return { source: resolve(source), ref, revision, workingTree, dirty, sourceSha256: hash.digest('hex'), repository: remote };
}

/** Revalidate source and binary identity before any integration request. */
export async function verifyPreparedCore(binary, harness) {
  const prepared = JSON.parse(await readFile(join(target, 'prepared.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(repository, 'sdk.lock.json'), 'utf8'));
  const current = await identifyCore(prepared.source, prepared.ref, prepared.workingTree, lock.coreSource.repository);
  if (JSON.stringify(current) !== JSON.stringify(prepared.identity)) throw new Error('Core source changed after preparation; run prepare-core again.');
  if (prepared.harnessSha256 !== await digest(harness) || prepared.binarySha256 !== await digest(binary)) throw new Error('Core harness or binary changed after preparation.');
}
