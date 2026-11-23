import type { ReactNode } from 'react';
import type { ProtectedServerState } from './membership';
import { useReorderDrag } from './ui/useReorderDrag';

type Channel = ProtectedServerState['channels'][number];

export function ProtectedChannelList({ channels, onReorder, renderChannel }: {
  channels: Channel[];
  onReorder(ids: string[], movedId: string): void;
  renderChannel(channel: Channel, drag: ReturnType<typeof useReorderDrag>): ReactNode;
}) {
  const drag = useReorderDrag(channels.map(channel => channel.id), onReorder);
  return <ul className="member-protected-channel-list" {...drag.list}>
    {channels.map(channel => <li key={channel.id} {...drag.item(channel.id)}>{renderChannel(channel, drag)}</li>)}
  </ul>;
}
