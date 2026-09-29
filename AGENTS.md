# Repository guidance

For packaging, GitHub Releases, updater publication, or release retries, read
`docs/RELEASING.md` before acting. Use the checked-in release workflow and preflight
script, not version-specific scripts in ignored `tmp/` directories. Keep offline
regressions isolated from personal accounts. Never move an existing release tag
or rerun a successful build merely because verification or upload failed.
Reuse retained candidate artifacts for verification retries; after test-only fixes,
use the release workflow reuse_run input after shipped-input validation. Run the
Windows proxy and motion preflight before tagging. Record stage timings and
prefer removing duplicate work over weakening release gates.
