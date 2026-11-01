import { NotFoundException } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';

describe('pipeline stage organization boundary', () => {
  function setup(stage: any) {
    const tx = {
      pipelineStage: {
        findFirst: jest.fn().mockResolvedValue(stage),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'stage-a' }),
      },
    };
    const prisma = {
      pipeline: { findUnique: jest.fn().mockResolvedValue({ id: 'pipeline-a', organizationId: 'org-a' }) },
      $transaction: jest.fn((fn) => fn(tx)),
    };
    return { service: new PipelinesService(prisma as any, {} as any), tx };
  }

  it('does not update a stage from another pipeline', async () => {
    const { service, tx } = setup(null);
    await expect(service.upsertStages('pipeline-a', 'org-a', [{ id: 'stage-b', name: 'changed' }]))
      .rejects.toThrow(NotFoundException);
    expect(tx.pipelineStage.update).not.toHaveBeenCalled();
  });

  it('updates a stage belonging to the selected pipeline', async () => {
    const { service, tx } = setup({ id: 'stage-a' });
    await service.upsertStages('pipeline-a', 'org-a', [{ id: 'stage-a', name: 'changed' }]);
    expect(tx.pipelineStage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'stage-a', pipelineId: 'pipeline-a' } }));
  });
});

describe('card linked records organization boundary', () => {
  function setup() {
    const prisma = {
      pipeline: { findUnique: jest.fn().mockResolvedValue({ id: 'pipeline-a', organizationId: 'org-a' }) },
      card: {
        findUnique: jest.fn().mockResolvedValue({ id: 'card-a', organizationId: 'org-a' }),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new' }),
        update: jest.fn().mockResolvedValue({ id: 'card-a' }),
      },
      contact: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
      userOrganization: { findUnique: jest.fn().mockResolvedValue(null) },
      pipelineStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-a' }) },
    };
    return { prisma, service: new PipelinesService(prisma as any, { emitToOrg: jest.fn() } as any) };
  }

  it.each(['contactId', 'conversationId', 'assignedToId'] as const)(
    'rejects foreign %s when updating a card', async (field) => {
      const { service, prisma } = setup();
      await expect(service.updateCard('card-a', 'org-a', { [field]: 'foreign' })).rejects.toThrow(NotFoundException);
      expect(prisma.card.update).not.toHaveBeenCalled();
    },
  );

  it('rejects a foreign contact when creating a card', async () => {
    const { service, prisma } = setup();
    await expect(service.createCard('pipeline-a', 'org-a', { title: 'Card', contactId: 'foreign' })).rejects.toThrow(NotFoundException);
    expect(prisma.card.create).not.toHaveBeenCalled();
  });

  it('accepts records within the organization and clearing links', async () => {
    const { service, prisma } = setup();
    prisma.contact.findFirst.mockResolvedValue({ id: 'contact-a' } as never);
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-a' } as never);
    prisma.userOrganization.findUnique.mockResolvedValue({ userId: 'user-a' } as never);
    await service.updateCard('card-a', 'org-a', { contactId: 'contact-a', conversationId: 'conversation-a', assignedToId: 'user-a' });
    await service.updateCard('card-a', 'org-a', { contactId: null, conversationId: null, assignedToId: null });
    expect(prisma.card.update).toHaveBeenCalledTimes(2);
  });
});
