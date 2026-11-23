import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from '../../apps/server/internal/access/testdata/decisions.json' with { type: 'json' };
import { explainAction, explainGrant, explainGrantEvidence, verifyAccessTransition, verifyRoleTransition } from '../../shared/protected-access.mjs';

test('explicit administrator entries change only the channel view allow list', () => {
  const actor = { id: 'actor', active: true, roles: ['admin'] };
  const peer = { id: 'peer', active: true, roles: ['admin'] };
  const higher = { id: 'higher', active: true, roles: ['higher'] };
  const policy = { owner: 'owner', order: ['admin', 'higher'], roles: {
    admin: { grants: ['server.administrator'] }, higher: { grants: [] },
  }, members: { actor, peer, higher } };
  const before = { kind: 'text', local: { roles: { '@everyone': { deny: ['channel.view'] } } } };
  const withRule = (id, rule) => ({ ...before, local: { ...before.local, profiles: { [id]: rule } } });
  for (const id of ['actor', 'peer']) {
    const explicit = withRule(id, { allow: ['channel.view'] });
    assert.equal(verifyAccessTransition(policy, actor, before, explicit), false);
    assert.equal(verifyAccessTransition(policy, actor, before, explicit, true), true);
    assert.equal(verifyAccessTransition(policy, actor, explicit, before, true), true);
    assert.equal(explainGrant(policy, policy.members[id], before, 'channel.view', 0), 'allowed');
    assert.equal(explainGrant(policy, policy.members[id], explicit, 'channel.view', 0), 'allowed');
  }
  assert.equal(verifyAccessTransition(policy, actor, before, withRule('peer', { allow: ['message.send'] }), true), false);
  assert.equal(verifyAccessTransition(policy, actor, before, withRule('peer', { deny: ['channel.view'] }), true), false);
  assert.equal(verifyAccessTransition(policy, actor, before, withRule('higher', { allow: ['channel.view'] }), true), false);
});

for (const vector of fixture.cases) {
  test(vector.name, () => {
    const actor = fixture.subjects[vector.actor];
    const target = fixture.subjects[vector.target];
    const scope = fixture.scopes[vector.scope];
    for (const subject of [actor, { ...actor, roles: [...(actor.roles ?? [])].reverse() }]) {
      assert.equal(explainAction(fixture.policy, subject, target, scope, vector.permission, vector.lift, 1), vector.want);
    }
  });
}
test('grant evidence follows category, personal, and base precedence without changing the decision', () => {
  const permission = 'channel.view';
  const policy = { owner: 'owner', roles: { '@everyone': { grants: [permission] }, limited: { grants: [] },
    added: { grants: [] }, staff: { grants: ['server.administrator'] } } };
  const member = { id: 'reader', active: true, roles: ['limited'] };
  const scope = { kind: 'text', synchronized: true, local: { profiles: { reader: { allow: [permission] } } },
    category: { roles: { limited: { deny: [permission] }, added: { allow: [permission] } } } };
  const evidence = (actor, effectiveScope, grant = permission) => {
    const result = explainGrantEvidence(policy, actor, effectiveScope, grant, 1);
    assert.equal(result.decision, explainGrant(policy, actor, effectiveScope, grant, 1));
    return result;
  };
  assert.deepEqual(evidence(member, scope), { permission, decision: 'channel_restricted',
    sources: [{ kind: 'category', roleId: 'limited', effect: 'deny' }] });
  assert.deepEqual(evidence({ ...member, roles: [] }, scope).sources, [{ kind: 'base', roleId: '@everyone', effect: 'allow' }]);
  assert.deepEqual(evidence({ ...member, roles: ['limited', 'added'] }, scope).sources, [{ kind: 'category', roleId: 'added', effect: 'allow' }]);
  assert.deepEqual(evidence(member, { ...scope, synchronized: false }).sources, [{ kind: 'channel', effect: 'allow' }]);
  assert.deepEqual(evidence({ ...member, roles: ['staff'] }, scope).sources, [{ kind: 'administrator', roleId: 'staff', effect: 'allow' }]);
  assert.equal(evidence(member, scope, 'history.full').permission, 'channel.view');
});
test('policy replay distinguishes delegated role edits from self-escalation', () => {
  const member = (id, ...roles) => ({ id, roles, active: true, timeoutUntil: 0 });
  const before = {
    owner: 'owner',
    roles: {
      '@everyone': { grants: ['channel.view', 'message.send'] },
      helper: { grants: [] },
      staff: { grants: ['role.edit', 'role.assign'] },
    },
    order: ['helper', 'staff'],
    members: {
      owner: member('owner'),
      actor: member('actor', 'helper', 'staff'),
      peer: member('peer', 'staff'),
      reader: member('reader'),
    },
  };
  const delegated = structuredClone(before);
  delegated.members.reader.roles = ['helper'];
  assert.equal(verifyRoleTransition(before, delegated, 'actor', []), true);
  delegated.members.peer.roles = ['helper', 'staff'];
  assert.equal(verifyRoleTransition(before, delegated, 'actor', []), false);

  const escalation = structuredClone(before);
  escalation.roles.helper.grants.push('server.administrator');
  assert.equal(verifyRoleTransition(before, escalation, 'actor', []), false);
  assert.equal(verifyRoleTransition(before, escalation, 'owner', []), false);
  assert.equal(verifyRoleTransition(before, escalation, 'owner', [], { actor: true }), true);

  const presentation = structuredClone(before);
  presentation.rolePresentation = { helper: { Name: 'Helpers', Color: '#5a89bc', Icon: '🐾' } };
  assert.equal(verifyRoleTransition(before, presentation, 'actor', []), true);
  presentation.rolePresentation.staff = { Name: 'Staff' };
  assert.equal(verifyRoleTransition(before, presentation, 'actor', []), false);
  presentation.rolePresentation.helper.Color = '#bad';
  assert.equal(verifyRoleTransition(before, presentation, 'owner', []), false);

  const administrator = structuredClone(before);
  administrator.roles.staff.grants.push('server.administrator');
  const blue = structuredClone(administrator);
  blue.rolePresentation = { staff: { Name: 'Staff', Color: '#5a89bc' } };
  assert.equal(verifyRoleTransition(administrator, blue, 'actor', []), true);
  blue.rolePresentation.staff.Mentionable = true;
  assert.equal(verifyRoleTransition(administrator, blue, 'actor', []), false);

  const removed = structuredClone(before);
  delete removed.roles.helper;
  removed.order.shift();
  removed.members.actor.roles.shift();
  const text = { kind: 'text', local: { roles: { helper: { deny: ['channel.view'] } } } };
  assert.equal(verifyRoleTransition(before, removed, 'actor', [text]), false);
});
