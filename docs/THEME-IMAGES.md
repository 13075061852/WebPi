# Cloud theme images

Theme originals remain in `assets/themes` for maintenance, but are excluded from the installer.
`assets/theme-images.json` maps those relative names to public StarImg image URLs.
The upload API follows https://starimg.vip/api-doc (`POST /api/upload`, multipart `file`, `X-API-Key`).
To add or replace images, set `STARIMG_API_KEY` in the maintenance shell and run
`node scripts/upload-theme-images.mjs`. Existing source hashes are skipped so retries do not re-upload completed images.
Never put the key in the manifest or application source.

CSS uses `halo-theme://images/themes/...`. The main process downloads only manifest entries,
using the app's configured proxy, and caches validated images in `userData/theme-images`.
Cached images work offline across restarts. Before the first successful download, a network
failure leaves the palette's base colour visible. The theme gallery loads visible CSS thumbnails
and the selected full background; it does not download every full image at startup.
The provider may recompress images, so source hashes are used for upload deduplication only.

Run `node test/verify-theme-images.mjs` for isolated cache/network failure regression.
Run `node scripts/verify-theme-cloud.mjs --remote` to download and decode every public image
without a key. Omit `--remote` for offline manifest and package-exclusion checks.
