import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),['tests/bookmarks-ui.cjs'],{env,stdio:'inherit',windowsHide:true});
child.once('error',error=>{console.error(error);process.exit(1);});
child.once('exit',code=>process.exit(code??1));
