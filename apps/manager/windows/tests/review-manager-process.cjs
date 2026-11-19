// Exercise the actual Manager main/window lifecycle without requesting elevation.
// Only the existing privileged broker API is denied in this disposable test.
const {Broker}=require('../desktop/backend.cjs');
Broker.prototype.request=async()=>{throw Object.assign(Error('permission'),{code:'permission'});};
require('../../../../tooling/dev/review-app.cjs');
