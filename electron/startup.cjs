const fs = require('node:fs');

class StartupSettings {
  constructor(app, file) {
    this.app = app;
    this.file = file;
    try { this.inTray = JSON.parse(fs.readFileSync(file, 'utf8')).inTray === true; }
    catch { this.inTray = false; }
  }
  options(inTray = this.inTray) { return { path: this.app.getPath('exe'), args: inTray ? ['--start-in-tray'] : [] }; }
  enabled() { return this.app.getLoginItemSettings(this.options()).openAtLogin; }
  setEnabled(enabled) {
    this.app.setLoginItemSettings({ ...this.options(), openAtLogin: enabled });
    return this.enabled();
  }
  setInTray(value) {
    const enabled = this.enabled();
    fs.writeFileSync(this.file, JSON.stringify({ inTray: value }));
    try { this.app.setLoginItemSettings({ ...this.options(value), openAtLogin: enabled }); }
    catch (error) { fs.writeFileSync(this.file, JSON.stringify({ inTray: this.inTray })); throw error; }
    this.inTray = value;
    return value;
  }
}
module.exports = { StartupSettings };
