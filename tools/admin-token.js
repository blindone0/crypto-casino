'use strict';
// Print or rotate the admin token used to unlock the operator panel.
//
//   node tools/admin-token.js            show the current token
//   node tools/admin-token.js --rotate   generate a new one and save it
const crypto = require('node:crypto');
const configMod = require('../src/config');

const cfg = configMod.load();

if (process.argv.includes('--rotate') || !cfg.adminToken) {
  const token = crypto.randomBytes(24).toString('base64url');
  configMod.save({ adminToken: token });
  console.log(`\n  New admin token (saved to config.json):\n  ${token}\n`);
  console.log('  Restart the server for it to take effect.');
  console.log('  Anyone holding this token has full operator access, so treat it like a key.\n');
} else {
  console.log(`\n  Admin token: ${cfg.adminToken}\n`);
  console.log('  Open the panel at /admin and paste it, or sign in with an admin account.');
  console.log('  Rotate it with: node tools/admin-token.js --rotate\n');
}
