const path=require('node:path');
const root=path.resolve(__dirname,'../..');
function config(component,profile=''){
 if(!['client','manager'].includes(component))throw Error('Component must be client or manager');
 if(profile&&!/^[a-zA-Z0-9_-]{1,40}$/.test(profile))throw Error('Invalid review profile');
 const directory=path.join(root,'release','review-apps',component+(profile?'-'+profile:''));
 return{root,component,profile,directory,runtime:path.join(directory,'runtime.json'),userData:path.join(directory,'profile')};
}
module.exports={config};
