'use strict';

const path = require('path');

// pdf.js needs an explicit standardFontDataUrl for non-embedded standard
// fonts (Times/Helvetica/etc.) — without it, every getDocument() call spams
// "UnknownErrorException: The standard font baseUrl parameter must be
// specified" warnings to stderr for any PDF that uses one. The Node build's
// NodeStandardFontDataFactory just does `fs.readFile(baseUrl + filename)`
// (plain string concat, no path.join) — so this must end with a path
// separator. Resolved via require.resolve so it's correct regardless of
// node_modules hoisting/nesting.
const STANDARD_FONT_DATA_URL =
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

module.exports = { STANDARD_FONT_DATA_URL };
