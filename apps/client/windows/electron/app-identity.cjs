// Must match the identity stamped on installed NSIS shortcuts.
const appId = 'local.pawtalk.desktop';
function windowIdentity(executable) {
  return { appId, appIconPath: executable, appIconIndex: 0,
    relaunchCommand: `"${executable}"`, relaunchDisplayName: 'PawTalk' };
}
module.exports = { appId, windowIdentity };
