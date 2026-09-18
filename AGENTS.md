# Repository guidance

For packaging, GitHub Releases, updater publication, or release retries, read
`docs/RELEASING.md` before acting. Use the checked-in release workflow and preflight
script, not version-specific scripts in ignored `tmp/` directories. Keep offline
regressions isolated from personal accounts. Never move an existing release tag
or rerun a successful build merely because its upload job failed.
