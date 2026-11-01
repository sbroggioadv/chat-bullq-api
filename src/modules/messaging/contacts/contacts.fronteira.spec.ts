import { NotFoundException } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { ContactsService } from './contacts.service';

describe('fronteira de contatos', () => {
  it('restringe a consulta à organização e responde 404 para contato alheio', async () => {
    const contact = { id: 'a', organizationId: 'A' };
    const findFirst = jest.fn(async ({ where }: any) => where.organizationId === 'A' ? contact : null);
    const repository = new ContactsRepository({ contact: { findFirst } } as any);
    const service = new ContactsService(repository, {} as any, {} as any, {} as any);
    await expect(service.findOne('a', 'B')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a', organizationId: 'B', deletedAt: null } }));
    await expect(service.findOne('a', 'A')).resolves.toEqual(contact);
  });
});
