#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repository } from './verify-sdk.mjs';
import { runProcess } from '../vendor/lithe-plugin-sdk/src/index.mjs';

const checkout = join(repository, '.artifacts/lithe-core');
const target = join(repository, '.artifacts/core-target');
const stamp = join(target, 'prepared.json');
const lock = JSON.parse(await readFile(join(repository, 'sdk.lock.json'), 'utf8'));
const harness = join(repository, 'test/core-harness.rs');
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(target, { recursive: true });
await rm(stamp, { force: true });

async function git(args) {
  const result = await runProcess('git', ['-C', checkout, ...args], { signal: AbortSignal.timeout(15000) });
  if (result.exitCode !== 0 || result.truncated) throw new Error(`Core checkout verification failed: ${result.stderr}`);
  return result.stdout.trim();
}

if (await git(['rev-parse', 'HEAD']) !== lock.source.revision) throw new Error('Core checkout must match sdk.lock.json source revision.');
const remote = (await git(['remote', 'get-url', 'origin'])).replace(/\.git$/, '');
if (remote !== lock.source.repository) throw new Error('Core checkout must originate from sdk.lock.json source repository.');
if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Core checkout has tracked modifications.');
const examples = join(checkout, 'rust/lithe-core/examples');
await mkdir(examples, { recursive: true });
await copyFile(harness, join(examples, 'svn-plugin-harness.rs'));
const result = await runProcess('cargo', [
  'build', '--locked', '--manifest-path', join(checkout, 'rust/Cargo.toml'),
  '-p', 'lithe-core', '--example', 'svn-plugin-harness', '--target-dir', target
], { signal: AbortSignal.timeout(600000), maxOutputBytes: 4 * 1024 * 1024 });
await writeFile(join(target, 'build.log'), result.stdout + result.stderr);
if (result.exitCode !== 0 || result.truncated) throw new Error(`Core bridge build failed; see ${join(target, 'build.log')}`);
await writeFile(stamp, JSON.stringify({
  revision: lock.source.revision,
  harnessSha256: await digest(harness),
  binarySha256: await digest(join(target, 'debug/examples/svn-plugin-harness'))
}, null, 2) + '\n');
console.log(`Prepared Core ${lock.source.revision}`);
