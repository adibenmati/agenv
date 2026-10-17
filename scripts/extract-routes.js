// scripts/extract-routes.js — usage: node scripts/extract-routes.js <server.js> > test/routes.inventory.json
"use strict";
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const re = /^\s*app\.(get|post|put|delete)\(\s*"([^"]+)"/gm;
const all = []; let m;
while ((m = re.exec(src))) all.push({ method: m[1].toUpperCase(), path: m[2] });
const seen = new Set(), unique = [];
for (const r of all) { const k = r.method + " " + r.path; if (!seen.has(k)) { seen.add(k); unique.push(r); } }
if (all.length !== 72 || unique.length !== 71) { console.error(`expected 72 declarations / 71 unique, got ${all.length}/${unique.length}`); process.exit(1); }
console.log(JSON.stringify(unique, null, 1));
