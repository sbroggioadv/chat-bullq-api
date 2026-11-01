import { OrgRole } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';

describe('isolamento de salas em tempo real', () => {
  const socket = (org: string) => ({
    id: `socket-${org}`, connected: true,
    data: { userId: 'user', organizationId: org, authReady: true, channelIds: [`channel-${org}`] },
    handshake: { auth: { token: 'token', organizationId: org }, headers: {} },
    join: jest.fn(), leave: jest.fn(), emit: jest.fn(), disconnect: jest.fn(),
  });
  function setup() {
    const prisma = {
      userOrganization: { findUnique: jest.fn(async () => ({ id: 'member', role: OrgRole.ADMIN })) },
      channel: { findMany: jest.fn(async () => [{ id: 'channel-A' }]), findUnique: jest.fn(async () => ({ organizationId: 'A' })) },
      conversation: { findUnique: jest.fn(async () => ({ organizationId: 'A', channelId: 'channel-A' })) },
    };
    const presence = { setOnline: jest.fn(), setActiveConversation: jest.fn() };
    const gateway = new RealtimeGateway({ verify: () => ({ sub: 'user' }) } as any, { get: jest.fn() } as any, presence as any, prisma as any, { getAccessibleChannelIds: jest.fn(async () => 'ALL') } as any);
    return { gateway, prisma };
  }
  it('não inscreve socket em organização sem associação', async () => {
    const { gateway, prisma } = setup();
    prisma.userOrganization.findUnique.mockResolvedValue(null as any);
    const client = socket('A');
    await gateway.handleConnection(client as any);
    expect(client.join).not.toHaveBeenCalledWith('org:A');
    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalledWith('user:user:org:A');
  });
  it('inscreve o usuário na sala pessoal da organização validada', async () => {
    const { gateway } = setup();
    const client = socket('A');
    await gateway.handleConnection(client as any);
    expect(client.join).toHaveBeenCalledWith('user:user:org:A');
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as any;
    gateway.emitToUserInOrg('user', 'A', 'event', {});
    expect(gateway.server.to).toHaveBeenCalledWith('user:user:org:A');
  });
  it('recusa conversa de outra organização e aceita a própria', async () => {
    const { gateway } = setup();
    const a = socket('A'); const b = socket('B');
    await gateway.handleJoinConversation(b as any, { conversationId: 'conversation-A' });
    await gateway.handleJoinConversation(a as any, { conversationId: 'conversation-A' });
    expect(b.join).not.toHaveBeenCalledWith('conv:conversation-A');
    expect(a.join).toHaveBeenCalledWith('conv:conversation-A');
  });
  it('concessão de canal só altera sockets da organização do canal', async () => {
    const { gateway } = setup();
    const a = socket('A'); const b = socket('B');
    const emit = jest.fn();
    gateway.server = { in: jest.fn(() => ({ fetchSockets: async () => [a, b] })), to: jest.fn(() => ({ emit })) } as any;
    await gateway.grantChannelToUser('user', 'channel-A');
    expect(a.join).toHaveBeenCalledWith('channel:channel-A');
    expect(b.join).not.toHaveBeenCalledWith('channel:channel-A');
    gateway.emitToChannel('channel-A', 'event', {});
    expect(gateway.server.to).toHaveBeenCalledWith('channel:channel-A');
  });
  it('só transmite digitação para a sala da conversa à qual o socket pertence', () => {
    const { gateway } = setup();
    const emit = jest.fn();
    const client = { ...socket('B'), rooms: new Set(['conv:conversation-B']), to: jest.fn(() => ({ emit })) };
    gateway.handleTyping(client as any, { conversationId: 'conversation-A', isTyping: true });
    expect(client.to).not.toHaveBeenCalled();
    gateway.handleTyping(client as any, { conversationId: 'conversation-B', isTyping: true });
    expect(client.to).toHaveBeenCalledWith('conv:conversation-B');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
