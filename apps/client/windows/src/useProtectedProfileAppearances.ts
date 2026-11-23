import { useEffect, useRef, useState } from 'react';
import { membership } from './membership';

type Appearance = { id: string; name?: string; avatar?: string; color?: string };
type RosterPage = { members: Appearance[]; revision: number; next?: string };

export function useProtectedProfileAppearances(serverId: string | undefined, channelId: string | undefined,
  profileIds: string[], voice = false, start?: { after: string; revision: number }) {
  const ids = [...new Set(profileIds)].sort().join(',');
  const after = start?.after, revision = start?.revision;
  const [refresh, setRefresh] = useState(0);
  const scope = JSON.stringify([serverId, channelId, voice, after, revision]);
  const resolved = useRef<{ scope: string; checked: Set<string>; profiles: Map<string, Appearance> } | undefined>(undefined);
  const [result, setResult] = useState<{ scope: string; profiles: Map<string, Appearance> }>();
  useEffect(() => {
    if ((!voice && !after) || !serverId || !ids) return;
    return window.desktop?.onMembershipProtectedEvent?.(event => {
      if (event.serverId === serverId && (event.type === 'state' || event.type === 'resync')) {
        if (resolved.current?.scope === scope) resolved.current.checked.clear();
        setRefresh(value => value + 1);
      }
    });
  }, [serverId, voice, ids, scope, after]);
  useEffect(() => {
    if (resolved.current?.scope !== scope) resolved.current = { scope, checked: new Set(), profiles: new Map() };
    if (!serverId || !ids) return;
    const { checked, profiles } = resolved.current;
    const requested = ids.split(',').filter(id => !checked.has(id));
    if (!requested.length) return;
    const remaining = new Set(requested);
    let active = true;
    async function resolve() {
      let cursor = after && revision !== undefined ? { after, revision } : undefined;
      do {
        const roster = await membership<RosterPage>('roster.protected.read', { serverId, channelId, ...(voice && { voice }), ...cursor });
        if (!active) return;
        for (const member of roster.members) {
          if (remaining.delete(member.id)) {
            checked.add(member.id);
            profiles.set(member.id, member);
          }
        }
        setResult({ scope, profiles: new Map(profiles) });
        const next = roster.next;
        cursor = next && [...remaining].some(id => id > next) ? { after: next, revision: roster.revision } : undefined;
      } while (cursor);
      for (const id of requested) checked.add(id);
    }
    void resolve().catch(() => {});
    return () => { active = false; };
  }, [serverId, channelId, ids, scope, voice, refresh, after, revision]);
  return result?.scope === scope ? result.profiles : undefined;
}
