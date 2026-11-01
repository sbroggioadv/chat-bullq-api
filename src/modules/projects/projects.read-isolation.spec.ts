import { ProjectsService } from './projects.service';

describe('detalhe do projeto por organização', () => {
  it('descarta vínculos alheios e preserva os próprios', () => {
    const svc = new ProjectsService({} as any, {} as any);
    const base: any = { id: 'proj-b', organizationId: 'org-b', name: 'Projeto', tasks: [], attachments: [], metadata: {}, responsibleUserId: 'user-a', responsible: { id: 'user-a', name: 'A', avatarUrl: null, organizations: [{ organizationId: 'org-a' }] }, contacts: [{ id: 'link-a', contactId: 'contato-a', contact: { organizationId: 'org-a', name: 'A' } }, { id: 'link-b', contactId: 'contato-b', contact: { organizationId: 'org-b', name: 'B' } }], conversations: [{ conversationId: 'conv-a', conversation: { organizationId: 'org-a' } }, { conversationId: 'conv-b', conversation: { organizationId: 'org-b' } }] };
    const result = svc.toDetail(base);
    expect(result.responsible).toBeNull();
    expect(result.responsibleUserId).toBeNull();
    expect(result.contacts.map(c => c.contactId)).toEqual(['contato-b']);
    expect(result.conversationIds).toEqual(['conv-b']);
    base.responsible = { id: 'user-b', name: 'B', avatarUrl: null, organizations: [{ organizationId: 'org-b' }] };
    base.responsibleUserId = 'user-b';
    expect(svc.toDetail(base).responsible).toEqual({ id: 'user-b', name: 'B', avatarUrl: null });
  });
});
