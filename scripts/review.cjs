// Local review profile: leave the installed application's data untouched.
const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.resolve(__dirname, '../release/review-profile'));
delete process.env.PAWTALK_DEV_URL;
require('../electron/main.cjs');
