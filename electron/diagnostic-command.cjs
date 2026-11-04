const { invitation } = require('./address.cjs');
// Only the validated address and certificate pin are included; never the room password.
function diagnosticCommand(address) {
  const room = invitation(address);
  if (!room) throw new Error('Требуется приглашение комнаты');
  const port = Number(new URL(room.origin).port);
  if (port > 65532) throw new Error('Неверный порт комнаты');
  const script = `$ErrorActionPreference='Stop'
$ip='${room.hostname}';$port=${port};$pin='${room.fingerprint}'
function Open-Tcp([int]$p){
 $c=New-Object Net.Sockets.TcpClient
 try {$t=$c.ConnectAsync($ip,$p);if(!$t.Wait(5000)){throw 'TCP timeout (5 seconds)'};$null=$t.GetAwaiter().GetResult();$c.ReceiveTimeout=5000;$c.SendTimeout=5000;return $c} catch {$c.Dispose();throw}
}
try {
 Write-Host ('Checking '+$ip+':'+$port)
 foreach($endpoint in @('/healthz','/rtc')) {
  $c=$null;$s=$null;$r=$null
  try {
   $c=Open-Tcp $port
   $s=New-Object Net.Security.SslStream($c.GetStream(),$false,([Net.Security.RemoteCertificateValidationCallback]{param($sender,$cert,$chain,$errors) return $true}))
   $s.ReadTimeout=5000;$s.WriteTimeout=5000
   $s.AuthenticateAsClient($ip,$null,[Security.Authentication.SslProtocols]::Tls12,$false)
   $sha=[Security.Cryptography.SHA256]::Create()
   try {$actual=([BitConverter]::ToString($sha.ComputeHash($s.RemoteCertificate.GetRawCertData()))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
   if($actual -ne $pin){throw 'Certificate mismatch. Request a new invitation from the host.'}
   $authority=$ip;if($ip.Contains(':')){$authority='['+$ip+']'}
   $request='GET '+$endpoint+' HTTP/1.1'+[char]13+[char]10+'Host: '+$authority+':'+$port+[char]13+[char]10+'Connection: close'+[char]13+[char]10+[char]13+[char]10
   $bytes=[Text.Encoding]::ASCII.GetBytes($request);$s.Write($bytes,0,$bytes.Length);$s.Flush()
   $r=New-Object IO.StreamReader($s);$line=$r.ReadLine()
   if($line -notmatch '^HTTP/1\\.[01] 200(?: |$)'){throw ('HTTP check failed for '+$endpoint+': '+$line)}
   Write-Host ('OK: TLS certificate and '+$endpoint) -ForegroundColor Green
  } finally {if($r){$r.Dispose()};if($s){$s.Dispose()};if($c){$c.Dispose()}}
 }
 $c=Open-Tcp ($port+1);$c.Dispose()
 Write-Host ('OK: voice TCP port '+($port+1)) -ForegroundColor Green
 Write-Host 'PASS: server, certificate, voice service and voice TCP port are reachable from this PC.' -ForegroundColor Green
 Write-Host 'Password, WebRTC/UDP and real audio still require a test call in Voicecord.'
 exit 0
} catch {
 Write-Host ('FAIL: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'Check that the room is running. For LAN use the same network/VPN; for Internet check router forwarding and firewall.'
 exit 1
}`;
  return 'powershell.exe -NoProfile -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}
module.exports = { diagnosticCommand };
