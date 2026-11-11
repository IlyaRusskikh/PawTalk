// Recognize the old Manager's two unlabelled output lines before an input
// element strips their line breaks. Never concatenate a password to a TLS pin.
export function managerInvitation(value) {
  if (typeof value !== 'string' || value.length > 14000) return null;
  const match = /^(pawtalk:\/\/[^/\s]+\/[a-f0-9]{64})\\?[ \t]*\r?\n[ \t]*([^\s]{1,1024})$/.exec(value.trim());
  return match ? { address: match[1], password: match[2] } : null;
}
