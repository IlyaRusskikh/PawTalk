const {app}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(process.env.PAWTALK_APP_TEST_DIR,'profile'));
delete process.env.PAWTALK_DEV_URL;
require('../electron/main.cjs');
