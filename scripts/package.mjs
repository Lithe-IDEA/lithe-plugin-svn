#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repository, verifySdk } from './verify-sdk.mjs';

export const pluginID = 'io.github.lithe-idea.svn-support';
export const source = join(repository, pluginID);

async function requireRegularTree(directory) {
  for (const name of await readdir(directory)) {
    const file = join(directory, name);
    const info = await lstat(file);
    if (info.isDirectory()) await requireRegularTree(file);
    else if (!info.isFile()) throw new Error(`Plugin packages cannot contain symbolic links or special files: ${file}`);
  }
}

/**
 * Assembles the package offline from this repository's sources and the
 * pinned Node SDK. The package holds no native code, so one ZIP serves every
 * Mac; Lithe treats it as read-only at runtime.
 */
export async function buildPackage(output = join(repository, 'dist'), expectedTag) {
  await verifySdk();
  await requireRegularTree(source);
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  if (manifest.id !== pluginID || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.vendor.signatureRequirement !== 'none') {
    throw new Error('The community package must have the expected ID, semantic version and community trust.');
  }
  if (expectedTag !== undefined && expectedTag !== `v${manifest.version}`) throw new Error('The release tag must match plugin.json version.');
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, '.svn-package-'));
  try {
    const packageRoot = join(staging, pluginID);
    await cp(source, packageRoot, { recursive: true });
    for (const entry of ['README.md', 'LICENSE', 'NOTICE']) await cp(join(repository, entry), join(packageRoot, entry));
    // The SDK's runtime modules only; its type declarations are for authors.
    const sdk = join(packageRoot, 'provider/vendor/lithe-plugin-sdk');
    await mkdir(sdk, { recursive: true });
    for (const name of await readdir(join(repository, 'vendor/lithe-plugin-sdk/src'))) {
      if (name.endsWith('.mjs')) await copyFile(join(repository, 'vendor/lithe-plugin-sdk/src', name), join(sdk, name));
    }
    // plugin.json names the entry exactly, so a rename fails here instead of
    // when Lithe first opens a working copy.
    for (const provider of manifest.vcsProviders) {
      if (!(await lstat(join(packageRoot, provider.launch.entry)).catch(() => null))?.isFile()) {
        throw new Error(`The package does not contain the declared entry ${provider.launch.entry}.`);
      }
    }
    await requireRegularTree(packageRoot);
    const archiveName = `svn-support-${manifest.version}-darwin.zip`;
    const stagedArchive = join(staging, archiveName);
    execFileSync('zip', ['-q', '-r', '-X', stagedArchive, pluginID], { cwd: staging, timeout: 30000 });
    const sha256 = createHash('sha256').update(await readFile(stagedArchive)).digest('hex');
    const directory = join(output, pluginID);
    await rm(directory, { recursive: true, force: true });
    await rename(packageRoot, directory);
    const archive = join(output, archiveName);
    await rename(stagedArchive, archive);
    await writeFile(`${archive}.sha256`, `${sha256}  ${archiveName}\n`);
    return { directory, archive, sha256 };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--expect-tag')) throw new Error('Usage: node scripts/package.mjs [--expect-tag v<version>]');
  console.log(JSON.stringify(await buildPackage(undefined, args[1]), null, 2));
}
