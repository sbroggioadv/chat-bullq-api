import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

describe('acesso ao canal em projetos por conversa', () => {
  it.each(['get', 'put'])('nega %s sem acesso antes de gravar', async (method) => {
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ channelId: 'restrito', isGroup: true, contact: { channels: [{ channelId: 'restrito', externalId: '1@g.us' }] } }) },
      projectConversation: { findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p' }), create: jest.fn(), update: jest.fn() },
    };
    const service = new ProjectsService(prisma, {} as any);
    jest.spyOn(service, 'toDetail').mockReturnValue({ id: 'p', exists: true } as any);
    const update = jest.spyOn(service, 'update').mockResolvedValue({} as any);
    const controller = new ProjectsController(service);
    const operation = method === 'get'
      ? (controller.getByConversation as any)('c', 'org', new Set())
      : (controller.updateByConversation as any)('c', 'org', {}, new Set());
    await expect(operation).rejects.toMatchObject({ status: 403 });
    expect(prisma.projectConversation.upsert).not.toHaveBeenCalled();
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
