import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private readonly repository: ContactsRepository) {}

  async findAll(organizationId: string, search: string | undefined, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(organizationId, search, skip, limit);
    return {
      contacts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.organizationId !== organizationId) throw new ForbiddenException();
    return contact;
  }

  async update(id: string, organizationId: string, dto: UpdateContactDto) {
    const existing = await this.findOne(id, organizationId);

    // When the operator explicitly sets a name we MUST mark the contact as
    // "name-locked-by-user" so the inbound pipeline doesn't overwrite it on
    // the next authoritative pushName arrival. We merge into existing
    // metadata to avoid wiping unrelated keys.
    let nextMetadata = dto.metadata;
    if (dto.name !== undefined && dto.name !== null) {
      const currentMeta =
        (existing.metadata as Record<string, any> | null | undefined) ?? {};
      nextMetadata = {
        ...currentMeta,
        ...(dto.metadata ?? {}),
        nameLockedByUser: true,
        nameLockedAt: new Date().toISOString(),
      };
    }

    return this.repository.update(id, {
      ...dto,
      ...(nextMetadata !== undefined ? { metadata: nextMetadata } : {}),
    });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }
}
