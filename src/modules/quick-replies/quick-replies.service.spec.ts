import { ConflictException, NotFoundException } from '@nestjs/common';
import { QuickRepliesService } from './quick-replies.service';

type FakeRow = {
  id: string;
  organizationId: string;
  userId: string | null;
  shortcut: string;
  title: string;
  content: string;
  deletedAt: Date | null;
};

const makeRepo = () => {
  const rows: FakeRow[] = [];
  let nextId = 1;
  return {
    rows,
    create: jest.fn(async (data: any) => {
      const row: FakeRow = {
        id: `q${nextId++}`,
        organizationId: data.organization.connect.id,
        userId: data.user?.connect?.id ?? null,
        shortcut: data.shortcut,
        title: data.title,
        content: data.content,
        deletedAt: null,
      };
      rows.push(row);
      return row;
    }),
    findByOrgAndUser: jest.fn(async (orgId: string, userId: string) =>
      rows.filter(
        (r) =>
          r.organizationId === orgId &&
          (r.userId === userId || r.userId === null) &&
          r.deletedAt === null,
      ),
    ),
    findById: jest.fn(async (id: string) =>
      rows.find((r) => r.id === id && r.deletedAt === null) ?? null,
    ),
    findByShortcut: jest.fn(
      async (orgId: string, userId: string | null, shortcut: string) =>
        rows.find(
          (r) =>
            r.organizationId === orgId &&
            r.userId === userId &&
            r.shortcut === shortcut &&
            r.deletedAt === null,
        ) ?? null,
    ),
    update: jest.fn(async (id: string, data: any) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    }),
    softDelete: jest.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('not found');
      row.deletedAt = new Date();
      return row;
    }),
  };
};

describe('QuickRepliesService', () => {
  let repo: ReturnType<typeof makeRepo>;
  let svc: QuickRepliesService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new QuickRepliesService(repo as any);
  });

  it('cria atalho privado do usuário', async () => {
    const row = await svc.create('org1', 'user1', {
      shortcut: 'oi',
      title: 'Saudação',
      content: 'Olá!',
    });
    expect(row.userId).toBe('user1');
    expect(row.organizationId).toBe('org1');
  });

  it('findAll retorna meus atalhos + legados org-wide (userId null)', async () => {
    repo.rows.push({
      id: 'legacy1',
      organizationId: 'org1',
      userId: null,
      shortcut: 'legado',
      title: 'Legado',
      content: 'olá',
      deletedAt: null,
    });
    await svc.create('org1', 'user1', { shortcut: 'meu', title: 'M', content: 'm' });
    await svc.create('org1', 'user2', { shortcut: 'dela', title: 'D', content: 'd' });
    const list = await svc.findAll('org1', 'user1');
    const shortcuts = list.map((r) => r.shortcut).sort();
    expect(shortcuts).toEqual(['legado', 'meu']);
  });

  it('conflito de shortcut considera apenas o escopo do mesmo usuário', async () => {
    await svc.create('org1', 'user1', { shortcut: 'oi', title: 'A', content: 'a' });
    await expect(
      svc.create('org1', 'user2', { shortcut: 'oi', title: 'B', content: 'b' }),
    ).resolves.toBeDefined();
    await expect(
      svc.create('org1', 'user1', { shortcut: 'oi', title: 'C', content: 'c' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update bloqueia colisão com OUTRO shortcut do mesmo usuário', async () => {
    const a = await svc.create('org1', 'user1', { shortcut: 'a', title: 'A', content: 'x' });
    await svc.create('org1', 'user1', { shortcut: 'b', title: 'B', content: 'y' });
    await expect(
      svc.update(a.id, 'org1', 'user1', { shortcut: 'b' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update do próprio shortcut (sem mudar) NÃO é conflito', async () => {
    const a = await svc.create('org1', 'user1', { shortcut: 'a', title: 'A', content: 'x' });
    await expect(
      svc.update(a.id, 'org1', 'user1', { shortcut: 'a', title: 'A2' }),
    ).resolves.toBeDefined();
  });

  it('ciclo criar → soft-delete → recriar mesmo shortcut passa sem 409', async () => {
    const a = await svc.create('org1', 'user1', { shortcut: 'oi', title: 'A', content: 'x' });
    await svc.remove(a.id, 'org1', 'user1');
    await expect(
      svc.create('org1', 'user1', { shortcut: 'oi', title: 'A2', content: 'y' }),
    ).resolves.toBeDefined();
  });

  it('findOne lança NotFound se o atalho é de outro usuário', async () => {
    const a = await svc.create('org1', 'user1', { shortcut: 'a', title: 'A', content: 'x' });
    await expect(svc.findOne(a.id, 'org1', 'user2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findOne permite acesso a atalho legado (userId null) por qualquer usuário da org', async () => {
    repo.rows.push({
      id: 'legacy1',
      organizationId: 'org1',
      userId: null,
      shortcut: 'l',
      title: 'L',
      content: 'l',
      deletedAt: null,
    });
    const row = await svc.findOne('legacy1', 'org1', 'user1');
    expect(row.id).toBe('legacy1');
  });
});
