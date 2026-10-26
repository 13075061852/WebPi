# Validation tiers

`npm run check:source` runs syntax, lint and fixture portability checks.
`npm run test:regressions` is the daily offline gate used by Linux CI. It
isolates HOME, Pi credentials and application data. Network behavior uses local
servers or injected responses; no personal account or paid model is required.

The offline gate includes the previously standalone connectivity, Cloudflare
CLI/configuration, project concurrency/focus, session model, SSH execution,
server grouping/history/latency/ports/workspace, and Office tool-registration
regressions. `verify-cloudflare.mjs` only runs the real CLI's `--version`;
authentication and deployment calls are mocked.

Keep these integration checks separate from that gate:

| Check | Required environment |
| --- | --- |
| `verify-image-runtime.mjs` | Configured image-provider account; `--live` generates a potentially billable image. Prefer the offline image-generation tests for daily work. |
| `verify-office-native.mjs` | Native Office/PDF conversion support and Chinese document fonts. |
| `verify-office-packaged-convert.mjs` | A built Windows application plus native conversion support. |
| `test/e2e/*.mjs` | Electron GUI and the prerequisites of each flow. Run foreground GUI checks sequentially. |

`node test/e2e/e2e-terminals.mjs` uses disposable application/Pi profiles and
checks deferred runtime loading, native shells, output flow control, resizing,
links, hide/reopen and process cleanup. Screenshots go to
`HALO_TEST_OUTPUT_DIR`, or the OS temporary directory by default.

`npm run test:audit` is a broader, environment-dependent diagnostic runner;
it is not the isolated daily gate. A local Windows pass does not establish a
Linux CI pass. Packaging/release validation remains in `docs/RELEASING.md`.
