// Real OS credentials/TLS used by native integration harnesses, never UI mocks.
const {session,net,safeStorage}=require('electron');
const {CredentialStore}=require('../electron/credentials.cjs');
const {MembershipClient}=require('../electron/membership-client.cjs');
const {membershipTransport}=require('../electron/membership-transport.cjs');
const {serverCertificate}=require('../electron/connection.cjs');
function createClient(directory){
 const credentials=new CredentialStore(directory,{isEncryptionAvailable:()=>safeStorage.isAsyncEncryptionAvailable(),encryptString:value=>safeStorage.encryptStringAsync(value),decryptString:async value=>(await safeStorage.decryptStringAsync(value)).result});
 return new MembershipClient({credentials,fetcher:membershipTransport(session,(...args)=>net.fetch(...args)),verify:address=>serverCertificate(address),trust:async()=>{}});
}
module.exports={createClient};
