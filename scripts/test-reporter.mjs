import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { repository } from './verify-sdk.mjs';
import { writeTestReportArtifacts } from '../vendor/lithe-testing/generate-test-report.mjs';

/** Preserve per-test timing in the upstream HTML/JUnit format. */
export default async function* report(events) {
  const tests = [];
  for await (const { type, data } of events) {
    if (!['test:pass', 'test:fail'].includes(type) || data.details?.type === 'suite') continue;
    tests.push({
      name: data.name,
      suite: data.file?.split('/').at(-1) ?? 'Subversion plugin',
      status: data.skip ? 'skipped' : type === 'test:pass' ? 'passed' : 'failed',
      durationMs: data.details?.duration_ms ?? 0,
      maxMs: data.file?.endsWith('scenario.test.mjs') ? 90000 : 15000,
      details: data.details?.error ? inspect(data.details.error) : ''
    });
  }
  const directory = join(repository, '.artifacts/test-stability');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'svn-plugin.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, runner: 'Node · Subversion plugin', warnMs: 1000, tests }, null, 2) + '\n');
  writeTestReportArtifacts(path);
  yield '';
}
