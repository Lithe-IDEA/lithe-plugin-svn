#!/usr/bin/env node
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, verifySdk } from './verify-sdk.mjs';
import { runProcess } from '../vendor/lithe-testing/test-timing-lib.mjs';

await verifySdk();
const tests = (await readdir(join(repository, 'test'))).filter((name) => name.endsWith('.test.mjs')).sort();
const directory = join(repository, '.artifacts/test-stability');
await mkdir(directory, { recursive: true });
const result = await runProcess({
  command: process.execPath,
  args: ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/test-reporter.mjs', '--test-reporter-destination=stdout',
    ...tests.map((name) => `test/${name}`)],
  cwd: repository, timeoutMs: 180000, streamStdout: true, streamStderr: true
});
await writeFile(join(directory, 'svn-plugin.log'), result.stdout + result.stderr);
if (result.timedOut || !result.terminationConfirmed) throw new Error('Plugin test suite timed out or its processes could not be cleaned up.');
process.exitCode = result.code ?? 1;
