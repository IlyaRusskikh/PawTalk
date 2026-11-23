const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const depth = 53;
const hash = (...fields) => {
  const digest = createHash('sha256');
  for (const field of fields) digest.update(field);
  return digest.digest();
};
const empty = hash('pawtalk-revision-audience-empty-v1');
const emptyGroups = hash('pawtalk-revision-profile-empty-v1');
const hexDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = () => Object.assign(new Error('UNVERIFIED_EPOCH_RECIPIENTS'), { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
const nodeHash = (tag, bit, left, right) => hash(Buffer.from([tag, bit]), left, right);
const keyBit = (id, bit) => (id[Math.floor(bit / 8)] & (0x80 >> (bit % 8))) !== 0;

function positionBranch(height, left, right) {
  return left.equals(right) ? left : nodeHash(2, height, left, right);
}

function add(set, leaf) {
  if (!set) return leaf;
  let split = 0;
  for (; split < 256 && set.id[split / 8] === leaf.id[split / 8]; split += 8) {}
  if (split === 256) throw invalid();
  split += Math.clz32(set.id[split / 8] ^ leaf.id[split / 8]) - 24;
  if (split < set.bit) {
    const [left, right] = keyBit(set.id, split) ? [leaf, set] : [set, leaf];
    return { id: left.id, bit: split, left, right, digest: nodeHash(1, split, left.digest, right.digest) };
  }
  if (keyBit(leaf.id, set.bit)) {
    set.right = add(set.right, leaf);
  } else {
    set.left = add(set.left, leaf);
    set.id = set.left.id;
  }
  set.digest = nodeHash(1, set.bit, set.left.digest, set.right.digest);
  return set;
}

function addRecipient(set, recipient) {
  if (!hexDigest(recipient?.id) || !hexDigest(recipient?.publicKey)) throw invalid();
  const id = Buffer.from(recipient.id, 'hex');
  return add(set, { id, bit: 256, digest: nodeHash(0, 0, id, Buffer.from(recipient.publicKey, 'hex')) });
}

function positionRoot(changes, from, to, current, start, height) {
  if (from < to && changes[from].first === start) {
    current = changes[from].digest;
    from += 1;
  }
  if (from === to) return current;
  const middle = start + 2 ** (height - 1);
  let low = from, high = to;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (changes[mid].first < middle) low = mid + 1;
    else high = mid;
  }
  const left = positionRoot(changes, from, low, current, start, height - 1);
  const right = positionRoot(changes, low, to, low === from ? current : changes[low - 1].digest, middle, height - 1);
  return positionBranch(height, left, right);
}

function revisionAudienceRoot(statements, saltForSet) {
  const limited = statements.filter(statement => !statement.archive).sort((a, b) => a.firstPosition - b.firstPosition);
  let set;
  const changes = [];
  for (const recipient of limited) {
    set = addRecipient(set, recipient);
    const first = recipient.firstPosition;
    const change = { first, digest: nodeHash(3, 0, saltForSet(set.digest), set.digest) };
    if (changes.at(-1)?.first === first) changes[changes.length - 1] = change;
    else changes.push(change);
  }
  return positionRoot(changes, 0, changes.length, nodeHash(3, 0, saltForSet(empty), empty), 0, depth).toString('hex');
}

function verifyPosition(root, position, setDigest, proof) {
  if (!hexDigest(root) || !Number.isSafeInteger(position) || position < 1 || !hexDigest(proof?.salt) ||
      !Array.isArray(proof.siblings) || proof.siblings.length !== depth || !proof.siblings.every(hexDigest)) throw invalid();
  let node = nodeHash(3, 0, Buffer.from(proof.salt, 'hex'), setDigest);
  for (let i = 0; i < depth; i += 1) {
    const sibling = Buffer.from(proof.siblings[i], 'hex');
    node = positionBranch(i + 1, position % 2 === 0 ? node : sibling, position % 2 === 0 ? sibling : node);
    position = Math.floor(position / 2);
  }
  if (node.toString('hex') !== root) throw invalid();
}

function verifyRevisionAudience(root, position, recipients, proof) {
  if (!Array.isArray(recipients) || recipients.length > 8192) throw invalid();
  let set, previous = '';
  for (const recipient of recipients) {
    if (!hexDigest(recipient?.id) || recipient.id <= previous || Object.keys(recipient).length !== 2) throw invalid();
    set = addRecipient(set, recipient);
    previous = recipient.id;
  }
  verifyPosition(root, position, set?.digest ?? empty, proof);
  return recipients;
}

function audienceProfileLeaf(profile, salt, digest) {
  if (![profile, salt, digest].every(hexDigest)) throw invalid();
  return { id: Buffer.from(profile, 'hex'), bit: 256,
    digest: hash(signatureFrame('pawtalk-revision-profile-v1', profile, salt, digest)) };
}

function openedProfileLeaf(profile, entries, opening) {
  if (!opening || Object.keys(opening).length !== 2 || !hexDigest(opening.contentSalt)) throw invalid();
  const members = hash('pawtalk-revision-profile-members-v1:', opening.contentSalt, JSON.stringify(entries)).toString('hex');
  return audienceProfileLeaf(profile, opening.salt, members);
}

function groupedRevisionAudienceRoot(statements, openingFor, saltForSet) {
  const profiles = new Map();
  for (const { archive, id, publicKey, profileId, firstPosition } of statements) {
    if (archive) continue;
    if (![id, publicKey, profileId].every(hexDigest) || !Number.isSafeInteger(firstPosition) || firstPosition < 1) throw invalid();
    if (!profiles.has(profileId)) profiles.set(profileId, { first: firstPosition, entries: [] });
    const group = profiles.get(profileId);
    if (group.first !== firstPosition) throw invalid();
    group.entries.push([id, publicKey]);
  }
  let set;
  const changes = [];
  const ordered = [...profiles].sort(([leftId, left], [rightId, right]) => left.first - right.first ||
    Buffer.compare(Buffer.from(leftId, 'hex'), Buffer.from(rightId, 'hex')));
  for (const [profile, { first, entries }] of ordered) {
    entries.sort(([left], [right]) => left < right ? -1 : Number(left > right));
    set = add(set, openedProfileLeaf(profile, entries, openingFor(profile)));
    const change = { first, digest: nodeHash(3, 0, saltForSet(set.digest), set.digest) };
    if (changes.at(-1)?.first === first) changes[changes.length - 1] = change;
    else changes.push(change);
  }
  return positionRoot(changes, 0, changes.length, nodeHash(3, 0, saltForSet(emptyGroups), emptyGroups), 0, depth).toString('hex');
}

function verifyGroupedRevisionAudience(root, position, recipients, proof, audience, exclusion) {
  const { profiles, openings } = audience ?? {};
  if (!Array.isArray(recipients) || recipients.length > 8192 || !profiles || typeof profiles !== 'object' || Array.isArray(profiles) ||
      !openings || typeof openings !== 'object' || Array.isArray(openings) || Object.keys(profiles).length !== recipients.length) throw invalid();
  const groups = new Map();
  let previous = '';
  for (const entry of recipients) {
    if (!hexDigest(entry?.id) || entry.id <= previous || !hexDigest(entry.publicKey) || Object.keys(entry).length !== 2) throw invalid();
    const profile = Object.hasOwn(profiles, entry.id) && profiles[entry.id];
    if (!hexDigest(profile)) throw invalid();
    if (!groups.has(profile)) groups.set(profile, []);
    groups.get(profile).push([entry.id, entry.publicKey]);
    previous = entry.id;
  }
  if (Object.keys(openings).length !== groups.size) throw invalid();
  let set;
  for (const [profile, entries] of groups) {
    if (!Object.hasOwn(openings, profile)) throw invalid();
    set = add(set, openedProfileLeaf(profile, entries, openings[profile]));
  }
  if (exclusion !== undefined) {
    const { excludedProfiles, removedGroups } = exclusion ?? {};
    if (!Array.isArray(excludedProfiles) || !excludedProfiles.length || excludedProfiles.length > 8192 ||
        !removedGroups || typeof removedGroups !== 'object' || Array.isArray(removedGroups)) throw invalid();
    const excluded = new Set();
    for (const profile of excludedProfiles) {
      if (!hexDigest(profile) || groups.has(profile) || excluded.has(profile)) throw invalid();
      excluded.add(profile);
    }
    for (const [profile, opening] of Object.entries(removedGroups)) {
      if (!excluded.has(profile) || !opening || typeof opening !== 'object' || Array.isArray(opening) ||
          Object.keys(opening).length !== 2) throw invalid();
      set = add(set, audienceProfileLeaf(profile, opening.salt, opening.digest));
    }
  }
  verifyPosition(root, position, set?.digest ?? emptyGroups, proof);
  return recipients;
}

module.exports = { revisionAudienceRoot, verifyRevisionAudience, groupedRevisionAudienceRoot, verifyGroupedRevisionAudience };
