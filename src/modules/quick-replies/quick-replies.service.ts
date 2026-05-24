import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { QuickRepliesRepository } from './quick-replies.repository';
import { CreateQuickReplyDto } from './dto/create-quick-reply.dto';
import { UpdateQuickReplyDto } from './dto/update-quick-reply.dto';

@Injectable()
export class QuickRepliesService {
  constructor(private readonly repository: QuickRepliesRepository) {}

  async create(orgId: string, userId: string, dto: CreateQuickReplyDto) {
    const existing = await this.repository.findByShortcut(
      orgId,
      userId,
      dto.shortcut,
    );
    if (existing) {
      throw new ConflictException('Shortcut already in use');
    }
    return this.repository.create({
      shortcut: dto.shortcut,
      title: dto.title,
      content: dto.content,
      organization: { connect: { id: orgId } },
      user: { connect: { id: userId } },
    });
  }

  async findAll(orgId: string, userId: string) {
    return this.repository.findByOrgAndUser(orgId, userId);
  }

  async findOne(id: string, orgId: string, userId: string) {
    const row = await this.repository.findById(id);
    if (
      !row ||
      row.organizationId !== orgId ||
      (row.userId !== null && row.userId !== userId)
    ) {
      throw new NotFoundException('Quick reply not found');
    }
    return row;
  }

  async update(
    id: string,
    orgId: string,
    userId: string,
    dto: UpdateQuickReplyDto,
  ) {
    const current = await this.findOne(id, orgId, userId);
    if (dto.shortcut !== undefined && dto.shortcut !== current.shortcut) {
      const clash = await this.repository.findByShortcut(
        orgId,
        current.userId,
        dto.shortcut,
      );
      if (clash && clash.id !== id) {
        throw new ConflictException('Shortcut already in use');
      }
    }
    return this.repository.update(id, {
      ...(dto.shortcut !== undefined && { shortcut: dto.shortcut }),
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
    });
  }

  async remove(id: string, orgId: string, userId: string) {
    await this.findOne(id, orgId, userId);
    return this.repository.softDelete(id);
  }
}
