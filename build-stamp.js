// Build stamp (reported feature) — this file is committed with the
// "dev" placeholder below so opening any page directly (file:// or a
// local server, no build step — see README's own "no build step, no
// install") always has it defined. On Vercel, scripts/generate-build-
// stamp.cjs OVERWRITES this exact file during the build step (see
// vercel.json's buildCommand / package.json's "build" script) from
// VERCEL_GIT_COMMIT_SHA + the build time, so the deployed static
// asset carries the real stamp — never a runtime fetch, never an API
// call. Loaded as an ordinary <script src> (same category as
// daylib.js/topbar.js), not a dynamic request made after page load.
window.BUILD_STAMP = 'dev';
