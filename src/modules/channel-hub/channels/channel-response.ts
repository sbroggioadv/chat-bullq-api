import type { Channel } from '@prisma/client';

/** Browser response allowlist. Provider credentials stay server-side. */
export function channelResponse(channel: Channel | null) {
  if (!channel) return null;
  const {
    id, organizationId, type, name, isActive, visibility, aiEnabled,
    createdAt, updatedAt, deletedAt,
  } = channel;
  const config = channel.config && typeof channel.config === 'object' && !Array.isArray(channel.config)
    ? channel.config as Record<string, unknown> : {};
  const filled = (value: unknown) => value !== null && value !== undefined && value !== '';
  const configFields = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, filled(value)]));
  // Derive booleans rather than echoing free-form scope strings or provider values.
  const granted = typeof config.scopeGranted === 'string' && config.scopeGranted
    ? config.scopeGranted : typeof config.scope === 'string' ? config.scope : '';
  const scopes = new Set(granted.split(/\s+/));
  const hasScope = (name: string) => scopes.has(`https://www.googleapis.com/auth/${name}`);
  const googlePermissions = type === 'GMAIL' ? {
    hasRead: hasScope('gmail.readonly') || hasScope('gmail.modify') || hasScope('gmail.send') || scopes.has('https://mail.google.com/') || filled(config.refreshToken),
    hasSend: config.hasGmailModify === true || hasScope('gmail.modify') || hasScope('gmail.send'),
    hasCalendar: config.hasCalendar === true || hasScope('calendar') || hasScope('calendar.events') || hasScope('calendar.readonly'),
  } : null;
  return {
    id, organizationId, type, name, isActive, visibility, aiEnabled,
    createdAt, updatedAt, deletedAt, configFields, googlePermissions,
  };
}
