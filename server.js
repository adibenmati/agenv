#!/usr/bin/env node
"use strict";
// The server itself is TypeScript (src/ → dist/). This file stays so everything that starts "server.js" —
// cli.js, electron.js, `npm start`, the Makefile — keeps working. The previous single-file server is tagged `pre-ts`.
const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("[agenv] dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
require(entry);
