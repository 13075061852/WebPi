# Windows installer

`installer.nsh` is electron-builder's `nsis.include`. Do **not** configure
`nsis.script`: electron-builder 26.15.3 skips its uninstaller generation,
uninstaller signing and final payload-size validation for a custom script.

Run `prepare-installer.cjs` from the `beforePack` build hook. (`beforeBuild` is
skipped when `npmRebuild` is false.) It generates narrowly instrumented copies
of the installed stock include files in `build/generated/`, rejecting an
unexpected builder version or changed patch anchor. The NSIS include switches
the compiler's include working directory to that generated directory, with
the original template directory retained in the include search path. The
builder's own `installer.nsi` still controls both compilation passes. Stock
template siblings are copied unchanged beside the instrumented includes;
otherwise Windows can resolve `multiUser.nsh` to NSIS's unrelated built-in
`MultiUser.nsh` before searching the original template directory.

The installer displays nine phases at actual operation boundaries. Elapsed
time is measured with `GetTickCount`; it is not a countdown or simulated
percentage. The native progress bar and current-file status remain active.
Only phase messages are added to the details list, avoiding thousands of
list-view updates while unpacking dependencies. Logs survive failed installs
at `%TEMP%\Pi-Halo-<version>-install.log` and are copied to `install.log` in the
application directory on completion.

For per-user installs, an empty destination on the same volume receives the
already-extracted directory with `Rename`, avoiding a second copy of every
file. `RMDir` is deliberately non-recursive, so existing files prevent this
fast path; failed cross-volume moves recreate the empty target and use the
stock copy/retry flow. Per-machine installs always copy so files inherit the
destination permissions rather than those of the private temporary directory.

The finishing page and silent `--force-run` update path launch the executable
using non-blocking `Exec` for ordinary per-user installs. UAC's existing outer
installer performs that call when installation was elevated through the
wizard. A setup explicitly started as administrator retains the upstream
de-elevating shell broker because it has no unelevated outer instance.

Before releasing, verify a fresh install, reinstall/update, a path containing
spaces and Chinese, launch checked/unchecked, silent update, and uninstall.
Confirm the generated uninstaller exists and the installation log reaches
verification. Visually check the actual installed wizard at desktop scaling;
do not use an HTML mockup as evidence of NSIS layout.
