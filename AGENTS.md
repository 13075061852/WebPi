# Repository guidance

Daily fixes, UI changes, and dependency or Pi kernel upgrades are source-only
work: do not increment the application version, build an installer, push changes,
create a release tag, or publish a Release. Start the packaging and publication
flow only when the user explicitly asks to push or publish the latest version.
If the user explicitly requests a test installer, build only that requested test
package without changing the formal application version or publishing it.

For packaging, GitHub Releases, updater publication, or release retries, read
`docs/RELEASING.md` before acting. Use the checked-in release workflow and preflight
script, not version-specific scripts in ignored `tmp/` directories. Keep offline
regressions isolated from personal accounts. Never move an existing release tag
or rerun a successful build merely because verification or upload failed.
Reuse retained candidate artifacts for verification retries. For an explicitly
requested cloud fallback, use reuse_run after test-only fixes and shipped-input
validation. Run the
Windows proxy and motion preflight before tagging. Record stage timings and
prefer removing duplicate work over weakening release gates.

Default release delivery is local Windows packaging followed by GitHub upload.
Keep the verified EXE, blockmap and latest.yml in local dist. Do not trigger a
cloud build when pushing a release tag; the cloud release workflow is manual
fallback only, used when the user explicitly asks for a cloud build. Reuse the
same local artifacts when upload or verification needs a retry.

## Prevent recurring CI failures during daily work

- Test fixtures must follow the injected platform and architecture, not the
  developer machine. A `platform: 'win32'` case needs explicit Windows paths and
  expected results on both Linux and Windows; cover x64, arm64 and unsupported
  cases. Gate only actual Windows integration operations on the host platform.
  The 1.0.13 Linux CI failure came from asserting the host platform after
  injecting win32 (`test/verify-environment-fallback.mjs`, fix `50230e9`).
- When a dependency or Pi kernel changes, check fixtures against the installed
  lockfile version and current runtime exports, model metadata and behavior.
  Update stale mocks with the feature change and run the affected regression;
  do not defer these checks until a release request.
- Proxy regressions must configure the application's saved proxy/direct mode;
  inherited proxy environment variables alone do not establish that mode. Keep
  the offline fixture isolated from personal HOME, authentication and Git state.
- UI motion checks must explicitly enable animations and make their window
  visible. Provide the required Chinese font and PowerShell environment for
  each runner. Run foreground GUI checks sequentially so they cannot steal
  focus from each other. Source checks supplement real packaged checks.
- Run the checked-in syntax, lint and affected regression commands while making
  the change. A Windows-only local pass is not evidence of Linux CI success;
  inspect the CI result for the exact commit before publishing.

## Release preparation, reuse and timing

- Before the expensive release stages, verify the actual GitHub CLI executable,
  authentication and target repository access. Git push credentials do not
  prove that `gh` is available or authenticated. Never print or record tokens.
- Use the checked-in local release runner described in `docs/RELEASING.md`.
  Resume its completed stages rather than assembling a new version-specific
  script or repeating manual build, verify and upload commands.
- Match reused evidence to current inputs and artifact hashes, not just the
  version in a filename. Record the commit, source/build/test input fingerprints,
  runtime versions and artifact digests. A stale report for the same version is
  not a successful check of the current installer.
- Reuse a successful local check only when its complete inputs are unchanged.
  A test-only fix invalidates the affected verification, not an identical
  installer. Changed application/build inputs invalidate the build and its
  downstream verification. Never rebuild solely for a network, upload, test
  fixture or test-environment failure.
- Overlap independent CI waiting and local preparation where the release runner
  supports it. Keep tag/publication gated on all required checks. Retain the
  same EXE, blockmap and latest.yml for retries; skip a remote asset only after
  its size and digest match. Verify the public updater after publication.
- Record real child-process start/end times, exit codes, cache/reuse decisions
  and retry causes per stage. Report CI queue/polling, manual gaps and network
  transfer separately where evidence permits. Do not present tool-observed
  elapsed time as pure test/build time or promise a speedup without a timed run.

Known release lessons and the detailed recovery procedure are maintained in
`docs/RELEASING.md`. In 1.0.10, stale proxy fixtures and cloud motion assumptions
caused two failed verification rounds and three builds of unchanged application
inputs. In 1.0.13, the platform-fixture error was fixed before building, so the
installer was built once. Preserve that separation between build and recovery.
