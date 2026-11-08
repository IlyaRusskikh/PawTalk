// Read-only TLS/pin check. Does not send a room password or modify router rules.
const { verifyInvitation, connectionError } = require('../electron/connection.cjs');
const { invitation } = require('../electron/address.cjs');
(async () => {
  const address = process.argv[2];
  const room = invitation(address);
  if (!room) throw new Error('Usage: node scripts/diagnose-room.cjs pawtalk://IP:port/fingerprint');
  try {
    await verifyInvitation(address);
    console.log(JSON.stringify({ ok: true, server: new URL(room.origin).host, message: 'TCP, TLS и сертификат приглашения проверены из текущей сети. Пароль и передача голоса не проверялись.' }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, server: new URL(room.origin).host, code: error.code, message: connectionError(error) }, null, 2));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
