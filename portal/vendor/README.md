# Vendored browser dependencies

`esptool-js-0.6.0.js` is the unmodified ESM bundle from the official
`esptool-js` 0.6.0 npm package published by Espressif. It is stored locally so
firmware installation does not depend on a runtime CDN or third-party request.

- upstream: <https://github.com/espressif/esptool-js>
- package: `esptool-js@0.6.0`
- npm tarball SHA-256:
  `57323d793c453756569519be2a67e435b52fceae1b2c81b0a3dac414ee9a3859`
- vendored bundle SHA-256:
  `7c361337d5bba7271cb0d9741f165a3b87137ff9284c13f112a6e197c48cd0da`
- license: Apache-2.0; see `esptool-js-0.6.0.LICENSE.txt`

Do not replace this file with a runtime import. Review and pin an intentional
new upstream release, update these hashes, and rerun the portal test suite.
