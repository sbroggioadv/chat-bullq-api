import type { Channel } from '@prisma/client';

/** Browser response allowlist. Provider credentials stay server-side. */
export function channelResponse(channel: Channel | null) {
  if (!channel) return null;
  const {
    id, organizationId, type, name, isActive, visibility, aiEnabled,
    createdAt, updatedAt, deletedAt,
  } = channel;
  return {
    id, organizationId, type, name, isActive, visibility, aiEnabled,
    createdAt, updatedAt, deletedAt,
  };
}
