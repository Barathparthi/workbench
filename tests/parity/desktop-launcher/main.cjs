'use strict';
/* global __dirname -- Electron's main process, CommonJS */
/**
 * Electron entry for the parity suite's desktop project (tests/parity/parity.ts). Playwright starts Electron as
 * `electron --inspect=0 --remote-debugging-port=0 <app> …`; Theia expects the app's path second and so would take it
 * for the folder to open. This launcher takes its own path out of the arguments and starts the real app's main, so
 * Theia opens the folder given last — as when a user starts the app.
 */
const { join, resolve } = require('node:path');

const own = process.argv.findIndex((arg, i) => i > 0 && resolve(arg) === __dirname);
if (own >= 0) process.argv.splice(own, 1);
require(join(__dirname, '..', '..', '..', 'apps', 'ide-electron', 'lib', 'backend', 'electron-main.js'));
