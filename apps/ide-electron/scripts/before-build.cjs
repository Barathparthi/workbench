/**
 * electron-builder `beforeBuild` hook (electron-builder.yml): the staged app has no node_modules of its own — Theia's
 * esbuild output in lib/ carries the bundles and the prebuilt Node-API binaries (ADR-012) — so there is nothing to
 * install or rebuild. Returning false tells electron-builder the modules are handled here; without it, it walks the
 * nearest node_modules (the monorepo's) and copies them into the installer.
 */
exports.default = async function beforeBuild() {
  return false;
};
