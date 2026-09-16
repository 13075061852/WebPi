# Windows installation and startup verification — 1.0.3

Tested on Windows 11 build 26200, Electron 44.0.0, x64, 2026-09-16. No antivirus exclusions, system tuning, or changes to the existing user's Pi Halo installation were used.

## Measured startup

`test/e2e/e2e-startup-performance.mjs` starts each process with a fresh isolated profile, local fixture model, offline mode, and isolated home. Each version ran three times. OS file caches were not flushed, so these are repeatable application-start observations, not machine cold-boot guarantees.

| Observation | Released 1.0.2 | 1.0.3 |
| --- | ---: | ---: |
| Main page discovered, median | 3,513 ms | 527 ms |
| Agent ready observed, median | 3,569 ms | 2,207 ms |
| Maximum 16 ms renderer timer gap, each run | 112 / 109 / 113 ms | 17 / 17 / 18 ms |

Page discovery precedes the window becoming visible. The separate real recovery E2E measured 1.0.3 first paint/window shown at 1,016 ms, core ready at 2,311 ms, and workspace ready at 2,340 ms. It also verified retry, safe bounded long errors in light/dark themes, a second instance focusing the existing instance, clean exit, and exit during initialization.

## Installer behavior

The actual NSIS wizard was tested with a separate application GUID, updater cache, shortcuts, installation folder, and explicit user-data directory. The installation path included spaces and Chinese characters. QA uses the production scripts and frozen production payload; only its identity and profile launch argument differ.

- Nine stages are logged at actual operation boundaries. The current operation and native progress bar remain visible. No fake countdown or per-file list flood is used.
- Stage headers were visually checked after multiple updates. Finish text and launch checkbox fit without overlap.
- A copy-path control install took 57 seconds: approximately 13 seconds decompressing and 40 seconds copying the extracted tree.
- The optimized overwrite install took 38 seconds, including 18 seconds removing the old version. Its directory-move write stage completed within the same recorded second. These totals cover different old-version states and are not a matched total-install speed ratio.
- The fast path only runs for a current-user install into an empty destination on the same volume. Removing that empty directory is nonrecursive. A failed rename restores the destination and falls back to the existing copy/retry path. All-users installations retain copying so destination ACL inheritance is preserved.
- Clicking Finish with launch enabled closed the installer and opened the installed app with the isolated workspace and fixture model ready.

## Package and functional checks

| Artifact observation | 1.0.2 | 1.0.3 |
| --- | ---: | ---: |
| Payload files | 13,042 | 7,249 |
| Payload bytes | 775,887,303 | 771,595,679 |
| Installer bytes | 230,076,669 | 223,557,447 |

Fewer loose files are achieved by archiving dependencies that can load from ASAR. Physical CLI, worker, WASM and native entrypoints keep their complete dependency closure. Unpack patterns account for electron-builder dependency hoisting; a standalone test caught and corrected a missing physical `minimatch` dependency before release. A platform-specific negative-only file list that broadened the package scope was removed, and release checks enforce allowed ASAR roots.

Final installer SHA256: `992c4ebaee3b02e1e00a7ccee2d4435daf820c8b0f3ab1cd3e2cc970fccf1874`.

Final embedded ASAR SHA256: `45ba57dfeaa9c4f8381ff2136d4ec3e52031e22cd026161f21404ee047e161a2`.

The verifier compared all 170 current source/asset files, version, ASAR root allowlist, EXE SHA-512/size, and every one of 10,688 blockmap chunks. The actual application payload was extracted outside the checkout so missing dependencies could not fall through to development `node_modules`.

Standalone functional smokes passed for real bundled Pi CLI/SDK and streamed tools, HTTP/HTTPS/NO_PROXY handling, all four Office formats and PDF canvas rendering, the image worker with Photon WASM, native canvas, ConPTY command output, Wrangler, and both esbuild runtimes. Startup lifecycle, model refresh, session integrity and existing UI regressions also passed.

The native terminal dependency emitted an upstream `AttachConsole failed` message during fixture teardown; command output assertions and process exit succeeded. GUI tests use normal desktop permissions: the restricted test sandbox could not initialize Electron GPU subprocesses, while normal desktop runs passed.

Generated evidence is retained locally under `test/results/`, `tmp/startup-performance/`, and `tmp/installer-qa/`. The release workflow runs checks before uploading all three update assets into one draft, rejecting duplicate drafts or attempts to replace a published version.
