// Must match the identity stamped on installed NSIS shortcuts.
const appId = 'local.pawtalk.desktop';
function windowIdentity(executable, appIconPath = executable, entry) {
  const relaunchCommand = (entry ? [executable, entry] : [executable]).map(value => `"${value}"`).join(' ');
  return { appId, appIconPath, appIconIndex: 0, relaunchCommand, relaunchDisplayName: 'PawTalk' };
}
module.exports = { appId, windowIdentity };
