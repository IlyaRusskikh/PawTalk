// Local review profile: leave the installed application's data untouched.
const { app } = require('electron');
const path = require('node:path');
// Keep API 1/older review experiments intact, outside the API 2 review profile.
const profile = process.argv.find(argument => argument.startsWith('--profile='))?.slice('--profile='.length) || '';
if (profile && !/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) {
  console.error('Review profile must contain 1–40 letters, digits, underscores or hyphens.');
  app.exit(1);
} else {
app.setPath('userData', path.resolve(__dirname, `../../../../release/review-api2-profile${profile ? '-' + profile : ''}`));
delete process.env.PAWTALK_DEV_URL;
require('../electron/main.cjs');
}
