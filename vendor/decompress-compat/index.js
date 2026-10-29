'use strict';
/* global module -- CommonJS, as its consumers require it */
/**
 * Stands in for `decompress` (4.2.1, unmaintained; every version can write outside the target folder through
 * crafted archive entries and symlink chains). Theia requires it as CommonJS and calls it as
 * `decompress(input, output?, options?)`; the maintained fork has the same signature and result (the extracted
 * files) and fixes both advisories from 11.1.4, but is ESM-only — hence the dynamic import.
 */
module.exports = async function decompress(input, output, options) {
  const { default: extract } = await import('@xhmikosr/decompress');
  return extract(input, output, options);
};
