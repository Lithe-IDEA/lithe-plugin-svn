# Subversion for Lithe (macOS)

Subversion is a community VCS provider plugin for Lithe. It lets Lithe's
version control tool window show and commit the changes of Subversion working
copies in an open project: status, diff against the base, history, annotate,
check-in, rollback, update, conflict resolution, and moves through svn.

**0.1.1 is a preview release.** Automated tests run the package against the
selected latest Lithe Core and a real `svn` client in this repository's CI;
native installation and full UI acceptance are still pending.

The plugin requires a Lithe preview whose host declares the `vcsProviders`
capability (API 3 `vcsProviders: 1` and `serverProcess: 1`) and offers
structured plugin diagnostics (`litheLogging: 1`). Older hosts refuse to
install it; stable Lithe 0.6.7 installs it but cannot start the provider, so
keep 0.1.0 there. Windows is not supported yet.

## Install

Install Subversion 1.8 or newer (for example `brew install subversion`) and
Node.js 20.3 or newer first. Node runs the provider; svn is not bundled and is
the client you already use, with its own configuration and credential cache.

Download `svn-support-0.1.1-darwin.zip` from
[Releases](https://github.com/Lithe-IDEA/lithe-plugin-svn/releases), or build it
with `node scripts/package.mjs`.
In Lithe, choose Settings → Plugins → Install from Disk, select the ZIP,
review the provider command, the svn client and its network use, and
restart. Enable Subversion, then open a project that is, or contains, a
Subversion working copy. 0.1.1 is not listed in
[Lithe Store](https://github.com/Lithe-IDEA/Lithe-store) yet: the Store cannot
tell stable hosts without `litheLogging: 1` apart, so install it from disk.

## How it works

Lithe finds working copies from the manifest's `.svn` marker, including a
working copy that encloses the opened folder, and watches `.svn/wc.db` for
changes. For each working copy it starts `node provider/svn-provider.mjs
--stdio` and sends the operations of Lithe's VCS provider contract
(`shared/contracts/vcs-provider-v1.md` in the Lithe repository). The provider
runs the user's `svn` in the working copy root and reads its `--xml` output
(`status`, `info`, `log`, `blame`).

Every invocation uses `--non-interactive`, so only Subversion's own credential
cache answers and the provider never sees a password. It runs with a UTF-8
`LC_CTYPE` and `LC_MESSAGES=C` so non-ASCII paths work and errors can be
classified. Commands that change the working copy or the repository are shown
in Lithe's console; reads are not. Working copies older than format 1.7 (one
`.svn` per directory) are reported as unsupported.

| Operation | svn | Notes |
| --- | --- | --- |
| `status` | `info`, `status --ignore-externals` | `head.revision` is the root directory's own working revision, as `svn info` shows it: after a check-in it stays at the older revision until `update` (mixed revisions). Paths in a changelist are listed like any other. Property changes of the root itself are not reported. An external is a root of its own. A move source is not listed; its destination is `renamed`. An unmodified locked file is not a change. |
| `baseContent` | `cat -r BASE` | A NUL byte makes the content binary. Added, replaced, and unversioned files have no base. Bases over 32 MiB are not shown. |
| `history`, `fileHistory` | `log --verbose` | The root's history starts at `HEAD`, so a revision just committed is listed; a file's starts at its base. A page whose changed paths exceed the output limit is returned with `changesTruncated`. |
| `annotate` | `blame`, then `log` for messages | Locally changed lines have no revision. Messages are left out when the log fails, for example offline. |
| `checkin` | `commit --depth empty` | Commits exactly the selected paths plus both halves of a move and added parent directories. Selected unversioned paths are added first, with everything below a new directory; selected missing paths are deleted. |
| `rollback` | `revert` | A scheduled add, delete, or replace is reverted with everything below it. Undoing a moved file deletes the copy and restores the source; a moved directory's copy stays on disk unversioned, because svn would delete unversioned files inside it. |
| `update` | `update --accept postpone` | Conflicts are read from status afterwards. |
| `fileOperation` | `add --parents`, `delete --force`, `move --parents` | An unversioned path is moved on disk instead, and never over an existing file or directory. |
| `resolve` | `resolve --accept working` | The user's working file is taken as the resolution. |
| `cleanup` | `cleanup` | |

Paths are passed with a trailing `@` so a name containing `@` is never read as
a peg revision; a move destination is not a target and is passed as it is.
svn errors map to contract codes by their first known code:

| svn codes | Contract error |
| --- | --- |
| `E155004`, `E155037` | `vcs.workingCopy.locked` |
| `E155036`, `E155021` | `vcs.workingCopy.unsupported` |
| `E155011`, `E160028`, `E160024`, `E170004` | `vcs.outOfDate` |
| `E155015` | `vcs.conflict` |
| `E170001`, `E215004`, `E230001` | `vcs.authentication.failed` |

A missing or unrunnable svn client is `vcs.tool.unavailable`. Any other failure
reaches Lithe as a provider failure with svn's message, with paths inside the
root shown relative to it.

Not in this version: Subversion locks, properties, changelists as groups,
branches/switch, relocate, and merge tracking.

## Diagnostic logs

Version 0.1.1 requires a host offering `litheLogging: 1`. The vendored official
Node SDK sends typed `lithe/log` notifications to the host's v2 catalog and
writer, in the current session's `plugins/io.github.lithe-idea.svn-support/host`
channel. Provider process and protocol facts remain in `vcs/svn`. The SDK owns each request's
terminal event: meaningful success is INFO, failed operations are ERROR, and
cancelled requests are not errors. Repeated background status/base-content
successes are suppressed; their failures remain visible.

A recovered annotation-history failure records one WARN `degraded` fact with
a stable code and still returns the annotation without messages. It never
copies history XML, source, command arguments, repository addresses or credentials
into diagnostics. VCS console output remains separate from logs. The SDK does
not print raw exception messages or stack traces for failed requests.

Use Lithe's log window and diagnostic export. The SDK source base revision
and local logging changes are identified by `sdk.lock.json`, with exact
per-file hashes and no claim of a released artifact. No plugin writer,
log directory or idle task is added. Windows still uses v1 logging;
no Windows v2 acceptance is claimed.

## Development

```sh
node --test test/svn-output.test.mjs test/xml.test.mjs   # parsing, no svn needed
node scripts/verify-sdk.mjs                               # vendored SDK matches sdk.lock.json
node scripts/package.mjs                                  # dist/ ZIP and SHA-256
```

`provider/svn-output.mjs` and `provider/xml.mjs` are pure and tested against
output recorded from a real svn (`test/fixtures/`). After a Subversion
upgrade, re-record with `scripts/record-fixtures.sh` and review the diff.

The scenario test runs the assembled package through Lithe Core's public JSON
API, exactly as the host starts it, against a throwaway `file://` repository.
It needs svn, Rust, and the selected host preview checked out at
`.artifacts/lithe-core`; the companion `litheLogging: 1` host change must land
first. See **Core integration source** below for strict source verification,
local unpublished working-tree validation and the full command.

```sh
node scripts/prepare-core.mjs
LITHE_SVN_INTEGRATION=1 node scripts/test.mjs
```

`LITHE_SVN` selects an svn client other than the first on `PATH`. Every Core
request and provider event wait is bounded, and each test stops its provider
session and Core process even when an assertion fails.

## Updating the SDK

The Node SDK is vendored from
[Lithe-IDEA/lithe-plugin-docs](https://github.com/Lithe-IDEA/lithe-plugin-docs).
`sdk.lock.json.sdkSource` records its true upstream base revision and the local
structured logging changes; each SDK file has a SHA-256 and explicit source
identity. The original `source` identifies historical test-support files;
`coreSource` independently selects the integration host (see **Core
integration source** below). Update the official SDK production inputs, review
the diff, update every changed hash, and run `node scripts/verify-sdk.mjs`.
Unpinned or changed vendor files are rejected before testing and packaging.

## Core integration source

CI and release verification explicitly check out `sdk.lock.json.coreSource.ref`
(`preview`) from the verified host repository. **Merge the companion host
structured logging change into preview before this plugin change**; preparation
rejects a host missing the typed operation catalog rather than attempting an
old-protocol fallback. It records the resolved commit and exact source SHA-256;
this moving test ref is not presented as a pinned release artifact. SDK vendor
hashes and the historical test-support source remain independently pinned.

Local validation can select a particular real host checkout and revision:

```sh
node scripts/prepare-core.mjs --source /path/to/Lithe-IDEA --ref HEAD --working-tree --target-dir /path/to/Lithe-IDEA/rust/target
LITHE_SVN_INTEGRATION=1 node scripts/test.mjs
```

`--working-tree` is a deliberate opt-in for local unpublished host changes;
without it, dirty sources are rejected. The origin must still match the host
repository and HEAD must resolve to the selected ref. The source remains
unchanged: a test-only Rust executable links the built Core library in the
plugin's private `.artifacts/core-target/`. Preparation records tracked and
untracked `rust/` and `shared/` bytes, the harness and executable hashes;
tests reject any drift after preparation. A caller may reuse an existing
Cargo target with `--target-dir`, but never shares plugin state or log files.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
