/* ============================================================================
   .env loader — must be imported BEFORE any module that reads process.env.

   Why this is its own file: ES module imports are evaluated before the body of
   the importing module. When the loader lived inside server.mjs as an inline
   IIFE, every imported module had already read process.env by the time it ran —
   so anything configured in .env (Stripe keys, mail keys, DATABASE_URL) looked
   unset. Importing this module first fixes the ordering, because imports are
   evaluated top to bottom.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const file = path.join(__dirname, '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // Real environment variables (Render's dashboard) always win over the file.
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export default true;
