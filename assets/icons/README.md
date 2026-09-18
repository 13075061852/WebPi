# Bundled Lucide SVG library

- Source: https://github.com/lucide-icons/lucide
- Package: lucide-static@1.47.0 (https://www.npmjs.com/package/lucide-static)
- npm tarball SHA-1: ad0520340308bc22b719e88f037a014866e5fe1f
- License: see LICENSE (Lucide ISC and inherited Feather MIT notices).

lucide.json contains unchanged icons/*.svg and tags.json from the published package.
Only static SVG data is bundled; no remote scripts, font files or runtime dependencies.
The icon_library agent tool serves names, tags, SVG and license text offline.
To refresh, pack an explicit version without scripts, inspect its license and SVGs,
then rebuild the JSON from its icons directory and tags.json. Keep the license and
this version/provenance record together. Do not fetch icons during app startup.
