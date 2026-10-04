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
Reuse retained candidate artifacts for verification retries; after test-only fixes,
use the release workflow reuse_run input after shipped-input validation. Run the
Windows proxy and motion preflight before tagging. Record stage timings and
prefer removing duplicate work over weakening release gates.

Default release delivery is local Windows packaging followed by GitHub upload.
Keep the verified EXE, blockmap and latest.yml in local dist. Do not trigger a
cloud build when pushing a release tag; the cloud release workflow is manual
fallback only, used when the user explicitly asks for a cloud build. Reuse the
same local artifacts when upload or verification needs a retry.
