# SignPath Foundation application preparation

Status: application submitted by the maintainer on 2026-09-19; awaiting review. Existing releases are unsigned.
No SignPath sponsorship or certificate has been granted to this project.

## Project information

- Project: Pi Halo (星环)
- Repository: https://github.com/13075061852/WebPi
- Downloads: https://github.com/13075061852/WebPi/releases
- License: MIT; bundled third-party components retain their own licenses.
- Platform: Windows x64, Electron, NSIS EXE installer.
- Build: GitHub Actions, `.github/workflows/release.yml`.
- Repository owner: `13075061852`.

Application description:

> Pi Halo is an open-source Windows desktop interface for the pi coding agent.
> It provides project workspaces, AI conversations, local and remote development
> previews, and user-configured model integrations. Windows installers are built
> from version-tagged source using GitHub Actions. We request free open-source
> code signing to authenticate our releases and reduce unsigned-publisher warnings.
> We understand that approval is discretionary and signing does not guarantee
> immediate Microsoft SmartScreen reputation.

## Maintainer information

- The maintainer has supplied the applicant name and contact email privately.
  Do not commit the contact email to the public repository.
- The maintainer confirms that GitHub account `13075061852` has MFA enabled.
- This is a single-maintainer project. The repository owner is responsible for
  authoring, reviewing and approving releases. No independent second reviewer
  is currently assigned; disclose this accurately to SignPath.
- Acceptance of any service terms still requires the maintainer's confirmation
  when the actual application form is ready for submission.

## Review before submission

1. Review all bundled dependencies/binaries for the Foundation's OSS-only rules.
   A top-level MIT license alone does not establish dependency eligibility.
2. Prepare a code-signing policy identifying actual maintainers and approvers.
   Add SignPath attribution only after approval, never imply existing sponsorship.
3. Review and document network behavior in a privacy policy: selected AI providers,
   OAuth providers, remote servers, package catalog, update checks, balances, and
   external preview pages. Do not claim the app never connects automatically.
4. Ask SignPath to confirm the allowed artifact configuration for the Electron
   executable, NSIS uninstaller and installer. Third-party binaries must not be
   re-signed as project-owned code without permission under their policy.

## Integration after approval

Obtain the approved organization ID, project slug, signing-policy slug and
artifact configuration from SignPath; keep the API token in GitHub Actions
secrets. Do not invent these values or commit credentials.

Signing must be part of the verified build, before final hashes/update metadata:

1. Build project-owned PE files, obtain required signatures, build/sign NSIS.
2. Validate trusted Authenticode signatures and timestamps with
   `scripts/verify-windows-signatures.ps1` and the approved publisher subject.
3. Produce blockmap/latest.yml from the final signed installer, then run the
   existing installer/hash/source verification and packaged runtime checks.
4. Preserve the verified signed artifacts for upload-only retries.
5. Publish a new version; never overwrite 1.0.7 or re-sign an already public asset.

Do not merely sign the installer after generating latest.yml/blockmap: that
changes its bytes and invalidates the updater's integrity metadata.

Application: https://signpath.org/apply
Conditions: https://signpath.org/terms.html
