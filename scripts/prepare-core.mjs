#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repository, verifySdk } from './verify-sdk.mjs';
import { runProcess } from '../vendor/lithe-plugin-sdk/src/index.mjs';
import { digest, identifyCore, target } from './core-source.mjs';

await verifySdk();
const lock = JSON.parse(await readFile(join(repository, 'sdk.lock.json'), 'utf8'));
let source = join(repository, '.artifacts/lithe-core');
let ref = lock.coreSource.ref;
let workingTree = false;
let buildTarget = join(target, 'build');
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index];
  if (option === '--source') { const value = process.argv[++index]; if (!value || value.startsWith('--')) throw new Error('--source requires a path.'); source = resolve(value); }
  else if (option === '--ref') ref = process.argv[++index];
  else if (option === '--target-dir') { const value = process.argv[++index]; if (!value || value.startsWith('--')) throw new Error('--target-dir requires a path.'); buildTarget = resolve(value); }
  else if (option === '--working-tree') workingTree = true;
  else throw new Error(`Unknown preparation option: ${option}`);
}
if (!ref || ref.startsWith('-')) throw new Error('A real source ref is required.');
const before = await identifyCore(source, ref, workingTree, lock.coreSource.repository);
await mkdir(target, { recursive: true });
await rm(join(target, 'prepared.json'), { force: true });
const harness = join(repository, 'test/core-harness.rs');
const binary = join(target, 'svn-plugin-harness');
const logs = [];
async function run(command, args) {
  const result = await runProcess(command, args, { signal: AbortSignal.timeout(600000), maxOutputBytes: 4 * 1024 * 1024 });
  logs.push(result.stdout + result.stderr);
  await writeFile(join(target, 'build.log'), logs.join('\n'));
  if (result.exitCode !== 0 || result.truncated) throw new Error(`Core bridge build failed; see ${join(target, 'build.log')}`);
}
await run('cargo', ['build', '--locked', '--manifest-path', join(source, 'rust/Cargo.toml'), '-p', 'lithe-core', '--lib', '--target-dir', buildTarget]);
await run('rustc', ['--edition=2021', harness, '--extern', `lithe_core=${join(buildTarget, 'debug/liblithe_core.rlib')}`, '-L', `dependency=${join(buildTarget, 'debug/deps')}`, '-o', binary]);
const after = await identifyCore(source, ref, workingTree, lock.coreSource.repository);
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Core source changed while building; prepare it again.');
await writeFile(join(target, 'prepared.json'), JSON.stringify({ ...before, identity: before, harnessSha256: await digest(harness), binarySha256: await digest(binary) }, null, 2) + '\n');
console.log(`Prepared Core ${before.revision} ref=${ref} dirty=${before.dirty} sha256=${before.sourceSha256}`);
