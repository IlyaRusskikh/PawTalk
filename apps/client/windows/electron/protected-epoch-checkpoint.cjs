const { createHash } = require('node:crypto');

const fail = code => Object.assign(new Error(code), { code });
const digestId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sequence = value => Number.isSafeInteger(value) && value > 0;

class ProtectedEpochCheckpoint {
  constructor(credentials) {
    this.credentials = credentials;
    this.pending = new Map();
  }

  run(trust, channel, purpose, operation) {
    const channelKey = createHash('sha256').update(channel).digest('hex');
    const key = `pawtalk:protected-epoch:v1:${trust.serverId}:${channelKey}:${purpose}`;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      const raw = await this.credentials.load(key, { required: true });
      const saved = raw == null ? undefined : JSON.parse(raw);
      if (raw != null && (!sequence(saved?.generation) || !sequence(saved.revision) ||
          !digestId(saved.digest) || saved.anchorDigest !== trust.anchorDigest ||
          (saved.livePolicy !== undefined && (purpose !== 'live' || !sequence(saved.livePolicy?.revision) ||
            saved.livePolicy.revision < saved.revision || !digestId(saved.livePolicy.digest))) ||
          (saved.archiveWrap !== undefined && (saved.archiveWrap !== true || purpose !== 'archive')))) {
        throw fail('INVALID_LOCAL_EPOCH_CHECKPOINT');
      }
      const save = next => this.credentials.save(key, JSON.stringify({ ...next, anchorDigest: trust.anchorDigest }));
      return operation(new EpochContinuity(channel, purpose, saved, save));
    });
    this.pending.set(key, running);
    return running.finally(() => {
      if (this.pending.get(key) === running) this.pending.delete(key);
    });
  }
}

class EpochContinuity {
  constructor(channel, purpose, head, save) {
    this.channel = channel;
    this.purpose = purpose;
    this.head = head;
    this.save = save;
  }

  checkScope(record) {
    if (record?.ChannelID !== this.channel || record.Purpose !== this.purpose ||
        !sequence(record.Generation) || !sequence(record.Revision) ||
        (record.Generation === 1 ? record.PreviousDigest !== '' : !digestId(record.PreviousDigest))) {
      throw fail('INVALID_EPOCH_CONTINUITY');
    }
  }

  async accept(proof, verify, fetchPage, expectedDigest, livePolicy) {
    const record = proof?.Record;
    this.checkScope(record);
    const generation = record.Generation;
    if (this.head && generation < this.head.generation) throw fail('EPOCH_ROLLBACK');
    const digest = await verify(proof);
    if (!digestId(digest) || (expectedDigest !== undefined && digest !== expectedDigest)) throw fail('EPOCH_FORK');
    const savedPolicy = this.head?.livePolicy;
    if (livePolicy && (this.purpose !== 'live' || !sequence(livePolicy.revision) ||
        livePolicy.revision < record.Revision || !digestId(livePolicy.digest))) throw fail('UNVERIFIED_EPOCH_POLICY');
    if (livePolicy && savedPolicy) {
      if (livePolicy.revision < savedPolicy.revision) throw fail('POLICY_ROLLBACK');
      if ((livePolicy.revision === savedPolicy.revision && livePolicy.digest !== savedPolicy.digest) ||
          (livePolicy.revision === savedPolicy.revision + 1 && livePolicy.previous !== savedPolicy.digest)) throw fail('POLICY_FORK');
    }
    const policyFloor = livePolicy ? { revision: livePolicy.revision, digest: livePolicy.digest } :
      savedPolicy?.revision >= record.Revision ? savedPolicy : undefined;
    if (this.head && generation === this.head.generation) {
      if (digest !== this.head.digest) throw fail('EPOCH_FORK');
      if (policyFloor && policyFloor.revision !== savedPolicy?.revision) {
        const next = { ...this.head, livePolicy: policyFloor };
        await this.save(next);
        this.head = next;
      }
      return digest;
    }
    if (this.head) {
      let previous = this.head;
      while (generation > previous.generation + 1) {
        const proofs = await this.proofs(fetchPage, previous.generation, generation - 1);
        for (const link of proofs) {
          this.checkScope(link?.Record);
          this.checkNext(previous, link.Record);
          previous = this.checkpoint(link.Record, await verify(link));
        }
      }
      this.checkNext(previous, record);
    }
    const next = this.checkpoint(record, digest);
    if (policyFloor) next.livePolicy = policyFloor;
    await this.save(next);
    this.head = next;
    return digest;
  }

  checkpoint(record, digest) {
    return { generation: record.Generation, revision: record.Revision, digest, ...(record.ArchiveWrapKey !== undefined && { archiveWrap: true }) };
  }

  checkNext(previous, next, signed = true) {
    if (next.Generation !== previous.generation + 1 || next.PreviousDigest !== previous.digest ||
        next.Revision < previous.revision || signed && previous.archiveWrap && next.ArchiveWrapKey === undefined) {
      throw fail('EPOCH_CHAIN_CONFLICT');
    }
  }

  async proofs(fetchPage, after, through) {
    if (typeof fetchPage !== 'function') throw fail('EPOCH_CHAIN_GAP');
    const links = await fetchPage(this.channel, this.purpose, after, through);
    if (!Array.isArray(links) || !links.length || links.length > Math.min(32, through - after)) {
      throw fail('EPOCH_CHAIN_GAP');
    }
    return links;
  }

  async prepare(task, verify, fetchPage) {
    this.checkScope(task);
    const previous = task.Generation - 1;
    if (this.head && previous < this.head.generation) throw fail('EPOCH_ROLLBACK');
    if (!previous) return;
    if (this.head?.generation === previous) {
      this.checkNext(this.head, task, false);
      return;
    }
    const [proof] = await this.proofs(fetchPage, previous - 1, previous);
    if (proof?.Record?.Generation !== previous || task.Revision < proof.Record.Revision) throw fail('EPOCH_CHAIN_GAP');
    await this.accept(proof, verify, fetchPage, task.PreviousDigest);
  }

  async verifyAncestor(proof, current, verify, fetchPage) {
    const record = proof?.Record;
    this.checkScope(record);
    if (!this.head || current.Generation < this.head.generation) throw fail('EPOCH_ROLLBACK');
    const currentDigest = createHash('sha256').update(Buffer.from(current.Signature, 'base64')).digest('hex');
    if (current.Generation !== this.head.generation || currentDigest !== this.head.digest ||
        record.Generation >= current.Generation) throw fail('EPOCH_FORK');
    let previous = this.checkpoint(record, await verify(proof));
    while (previous.generation + 1 < current.Generation) {
      const page = await this.proofs(fetchPage, previous.generation, current.Generation - 1);
      for (const link of page) {
        this.checkScope(link?.Record);
        this.checkNext(previous, link.Record);
        previous = this.checkpoint(link.Record, await verify(link));
      }
    }
    this.checkNext(previous, current);
  }
}

module.exports = { ProtectedEpochCheckpoint };
