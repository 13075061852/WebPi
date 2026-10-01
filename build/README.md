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

The finishing page queues a single launch and closes the window. `.onGUIEnd`
then launches the executable, so even a slow process-creation or shell-broker
call cannot leave a frozen Finish page. The silent `--force-run` update path
keeps its stock install-section condition. Both use non-blocking `Exec` for
ordinary per-user installs. UAC's existing outer
installer performs that call when installation was elevated through the
wizard. A setup explicitly started as administrator retains the upstream
de-elevating shell broker because it has no unelevated outer instance.

Before releasing, verify a fresh install, reinstall/update, a path containing
spaces and Chinese, Finish-to-launch, silent update, and uninstall.
Confirm the generated uninstaller exists and the installation log reaches
verification. Visually check the actual installed wizard at desktop scaling;
do not use an HTML mockup as evidence of NSIS layout.

## Minimal installer UI

`installer-ui.nsh` rearranges all installer pages into a DPI-scaled
white window with centered Pi Halo branding and a thin native progress bar.
The stage label follows real operations; no timed or simulated percentage is
shown. Detailed records remain in install.log. Window dimensions and white
background stay consistent across pages at 600 x 440 logical pixels. The scope
page is skipped by the stock PRE handler: manual installs default to the current
user, while an update preserves an existing per-machine installation. Path entry
and Browse share one compact field while keeping native validation and editing.
The finish page has only Finish, which closes the window before launching the app; stock reboot choices
remain usable when a restart is required.

`installer-window.c` supplies native caption drawing, drag/minimize/close and
button painting. It preserves NSIS's keyboard, validation and command handlers.
Its x86 DLL is checked in with source/binary hashes in `installer-window.json`;
the build hook rejects stale or modified binaries. Recompile changes with
`node build/compile-installer-window.cjs <path-to-tcc.exe>` using TinyCC 0.9.27
win32. Release builds verify this retained DLL without downloading a compiler.
The DLL is extracted directly to `$PLUGINSDIR` during GUI initialization;
never rely on `$OUTDIR`, which is not initialized until the install section.

Run `node test/verify-installer-native.mjs --runtime --nsis <makensis.exe>`
after NSIS is available. Its silent, non-installing fixture checks extraction
and exports with a missing output directory and two concurrent processes.
Artifact verification also compares the DLL embedded in the actual setup EXE.

For visual checks without installing or starting the app, compile
`node test/tools/build-installer-ui-preview.mjs --nsis <makensis.exe>` and open
its returned preview executable. Finish writes a unique marker with launch count;
it never changes the selected target directory or writes registry entries.
