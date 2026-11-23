// Evaluated with the repository root as electron-builder's project directory.
const config={
  "appId": "local.pawtalk.desktop",
  "productName": "PawTalk",
  "protocols": [
    {
      "name": "Приглашение PawTalk",
      "schemes": [
        "pawtalk"
      ]
    }
  ],
  "directories": {
    "output": "release"
  },
  "files": [
    "apps/client/windows/dist/**/*",
    "apps/client/windows/electron/**/*",
    "apps/server/internal/access/catalog.json",
    "shared/**/*",
    "package.json",
    "THIRD_PARTY_NOTICES.md",
    "licenses/**/*",
    "apps/client/windows/assets/**/*",
    "LICENSE"
  ],
  "extraResources": [
    {
      "from": "apps/client/windows/scripts/check-selfhost.ps1",
      "to": "diagnostics/check-selfhost.ps1"
    },
    {
      "from": "apps/client/windows/native/build/Release/pawtalk.node",
      "to": "pawtalk.node"
    },
    {
      "from": "resources/server",
      "to": "server",
      "filter": [
        "pawtalk-api.exe",
        "livekit-server.exe",
        "bundled-server.json",
        "GO-LICENSE",
        "LIVEKIT-LICENSE"
      ]
    },
    {
      "from": "apps/client/windows/scripts/install-update.ps1",
      "to": "updates/install-update.ps1"
    }
  ],
  "npmRebuild": false,
  "win": {
    "target": "nsis",
    "signAndEditExecutable": true,
    "icon": "apps/client/windows/assets/pawtalk.ico",
    "signExecutable": false
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "installerIcon": "apps/client/windows/assets/pawtalk.ico",
    "uninstallerIcon": "apps/client/windows/assets/pawtalk.ico",
    "installerLanguages": [
      "en_US",
      "ru_RU"
    ],
    "displayLanguageSelector": true,
    "include": "apps/client/windows/build/installer.nsh",
    "deleteAppDataOnUninstall": false
  },
  "extraMetadata": {
    "name": "pawtalk",
    "main": "apps/client/windows/electron/main.cjs"
  }
};
config.extraMetadata.version=require('./package.json').version;
module.exports=config;
