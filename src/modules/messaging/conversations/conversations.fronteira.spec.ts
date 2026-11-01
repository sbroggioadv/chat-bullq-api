import { NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

describe('fronteira das referências de conversa', () => {
  it('recusa departamento e membro de outra organização antes de alterar a conversa', async () => {
    const repository = { findById: jest.fn(async () => ({ id: 'conv-A', organizationId: 'A', channelId: 'channel-A' })), update: jest.fn() };
    const fsm = { assign: jest.fn() };
    const prisma = { department: { findFirst: jest.fn(async () => null) }, userOrganization: { findFirst: jest.fn(async () => null) } };
    const projects = { attachByConversationIds: jest.fn(async () => new Map()) };
    const service = new ConversationsService(repository as any, fsm as any, { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any, prisma as any, {} as any, {} as any, { assertChannelAccess: jest.fn() } as any, {} as any, {} as any, {} as any, projects as any);
    await expect(service.update('conv-A', 'A', { departmentId: 'department-B' }, 'user-A')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('conv-A', 'A', { assignedToId: 'user-B' }, 'user-A')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.update).not.toHaveBeenCalled();
    expect(fsm.assign).not.toHaveBeenCalled();
    expect(prisma.department.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'department-B', organizationId: 'A' }) }));
    expect(prisma.userOrganization.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user-B', organizationId: 'A' }) }));
    prisma.department.findFirst.mockResolvedValue({ id: 'department-A' } as any);
    prisma.userOrganization.findFirst.mockResolvedValue({ id: 'member-A' } as any);
    await service.update('conv-A', 'A', { departmentId: 'department-A', assignedToId: 'user-A' }, 'user-A');
    expect(fsm.assign).toHaveBeenCalledWith('conv-A', 'user-A', 'user-A');
    expect(repository.update).toHaveBeenCalledWith('conv-A', { department: { connect: { id: 'department-A' } } });
  });
});
