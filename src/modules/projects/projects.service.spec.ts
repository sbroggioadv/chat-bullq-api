import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import type { EmailService } from '../email/email.service';

function emptyDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    organizationId: 'org1',
    name: 'Holding X',
    description: null,
    groupJid: null,
    hoppeId: null,
    responsibleUserId: null,
    responsible: null,
    status: 'TODO',
    metadata: {},
    tasks: [],
    attachments: [],
    contacts: [],
    conversations: [],
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma() {
  const store = {
    projects: [emptyDetail()] as any[],
    links: [] as any[],
    tasks: [] as any[],
    attachments: [] as any[],
    contacts: [] as any[],
  };
  let taskSeq = 1;
  const prisma = {
    project: {
      create: jest.fn(async ({ data }: any) => {
        const row = emptyDetail({
          id: `p${store.projects.length + 1}`,
          ...data,
        });
        store.projects.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.projects.filter(
          (p) =>
            p.organizationId === where.organizationId &&
            p.deletedAt == null &&
            (!where.status || p.status === where.status),
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        store.projects.find(
          (p) =>
            (!where.id || p.id === where.id) &&
            p.organizationId === where.organizationId &&
            p.deletedAt == null &&
            (!where.groupJid || p.groupJid === where.groupJid),
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        store.projects.find((p) => p.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.projects.find((p) => p.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    projectConversation: {
      findFirst: jest.fn(async ({ where }: any) =>
        store.links.find((l) => l.conversationId === where.conversationId) ??
        null,
      ),
      upsert: jest.fn(async ({ create }: any) => {
        store.links.push(create);
        return create;
      }),
    },
    projectTask: {
      aggregate: jest.fn(async () => ({ _max: { sortOrder: 0 } })),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `t${taskSeq++}`, done: false, ...data };
        store.tasks.push(row);
        const project = store.projects.find((p) => p.id === data.projectId);
        project.tasks.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        store.tasks.find(
          (t) => t.id === where.id && t.projectId === where.projectId,
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.tasks.find((t) => t.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        store.tasks = store.tasks.filter((t) => t.id !== where.id);
        return { count: 1 };
      }),
    },
    projectAttachment: {
      create: jest.fn(async ({ data }: any) => {
        store.attachments.push(data);
        return data;
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    projectContact: {
      upsert: jest.fn(async ({ create }: any) => {
        store.contacts.push(create);
        return create;
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    conversation: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id === 'conv-missing') return null;
        return {
          id: where.id,
          organizationId: 'org1',
          deletedAt: null,
          isGroup: false,
          channelId: 'ch1',
          contactId: 'c1',
          contact: {
            name: 'Cliente',
            channels: [{ channelId: 'ch1', externalId: 'x' }],
          },
        };
      }),
    },
    contact: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'c1'
          ? { id: 'c1', organizationId: 'org1', deletedAt: null, email: 'a@b.com' }
          : null,
      ),
    },
    message: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: where.id,
        conversationId: 'conv1',
        type: 'DOCUMENT',
        content: { fileName: 'proc.pdf', url: 'https://x/proc.pdf', text: '' },
        conversation: { id: 'conv1' },
      })),
    },
    userOrganization: {
      findFirst: jest.fn(async () => ({ userId: 'u1' })),
    },
  };
  return { prisma, store };
}

describe('ProjectsService (dossiê)', () => {
  let svc: ProjectsService;
  let email: { status: jest.Mock; compose: jest.Mock };

  beforeEach(() => {
    const { prisma } = makePrisma();
    email = {
      status: jest.fn(async () => ({ channels: [{ id: 'gmail1' }] })),
      compose: jest.fn(async (org: string, _a: string, input: any) => ({
        org,
        ...input,
      })),
    };
    svc = new ProjectsService(prisma as any, email as unknown as EmailService);
  });

  it('cria dossiê sem groupJid e com fase TODO', async () => {
    const created = await svc.create('org1', { name: '  Caso Y  ' });
    expect(created.exists).toBe(true);
    expect(created.name).toBe('Caso Y');
    expect(created.groupJid).toBeNull();
    expect(created.status).toBe('TODO');
    expect(created.conversationIds).toEqual([]);
  });

  it('conversa sem vínculo não vira projeto automático', async () => {
    const found = await svc.getForConversation('org1', 'conv-new');
    expect(found.exists).toBe(false);
    expect(found.id).toBeNull();
  });

  it('updateForConversation cria dossiê e liga a conversa (não upsert por JID)', async () => {
    const saved = await svc.updateForConversation('org1', 'conv1', {
      name: 'Dossiê do chat',
      status: 'WAITING_DOCS',
    });
    expect(saved.exists).toBe(true);
    expect(saved.name).toBe('Dossiê do chat');
    expect(saved.status).toBe('WAITING_DOCS');
  });

  it('recusa fase inválida', async () => {
    await expect(
      svc.update('org1', 'p1', { status: 'Onboarding' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('adiciona task ao dossiê', async () => {
    const after = await svc.addTask('org1', 'p1', { title: 'Pedir documentos' });
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0].title).toBe('Pedir documentos');
  });

  it('anexa mensagem e liga a conversa de origem', async () => {
    const after = await svc.attachMessage(
      'org1',
      'p1',
      { messageId: 'm1' },
      'u1',
    );
    expect(after.id).toBe('p1');
  });

  it('e-mail exige destinatário quando envolvidos não têm e-mail', async () => {
    await expect(
      svc.emailParticipants('org1', 'p1', {
        subject: 'Diligência',
        body: 'Segue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('e-mail usa Gmail conectado quando há destinatário extra', async () => {
    const result = await svc.emailParticipants('org1', 'p1', {
      subject: 'Diligência',
      body: 'Segue pedido',
      to: 'cliente@example.com',
    });
    expect(email.compose).toHaveBeenCalledWith(
      'org1',
      'ALL',
      expect.objectContaining({
        channelId: 'gmail1',
        to: 'cliente@example.com',
        subject: 'Diligência',
      }),
    );
    expect(result).toMatchObject({ channelId: 'gmail1' });
  });

  it('404 quando o dossiê não existe', async () => {
    await expect(svc.getById('org1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
