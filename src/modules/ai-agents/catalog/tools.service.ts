import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { UpsertCustomToolDto } from './dto/upsert-tool.dto';

@Injectable()
export class ToolsCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista built-in (org=null) + custom da org. */
  async list(organizationId: string) {
    return this.prisma.aiTool.findMany({
      where: {
        deletedAt: null,
        OR: [{ organizationId: null }, { organizationId }],
      },
      orderBy: [{ source: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(organizationId: string, id: string) {
    const tool = await this.prisma.aiTool.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ organizationId: null }, { organizationId }],
      },
    });
    if (!tool) throw new NotFoundException('Tool not found');
    return tool;
  }

  async create(organizationId: string, dto: UpsertCustomToolDto) {
    await this.assertNameAvailable(organizationId, dto.name);
    this.assertSourceFields(dto);

    return this.prisma.aiTool.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        source: dto.source,
        parameters: dto.parameters as object,
        // HTTP
        httpMethod: dto.httpMethod?.toUpperCase(),
        httpUrl: dto.httpUrl,
        httpHeaders: (dto.httpHeaders as object) ?? {},
        httpBodyTemplate: dto.httpBodyTemplate,
        responseMap: (dto.responseMap as object) ?? null,
        // SQL
        sqlConnectionRef: dto.sqlConnectionRef,
        sqlQuery: dto.sqlQuery,
        sqlParamMap: (dto.sqlParamMap as object) ?? null,
        sqlReadOnly: dto.sqlReadOnly ?? true,
        sqlMaxRows: dto.sqlMaxRows ?? 50,
        timeoutMs: dto.timeoutMs ?? 15000,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(organizationId: string, id: string, dto: UpsertCustomToolDto) {
    const tool = await this.findOne(organizationId, id);
    if (tool.source === 'BUILTIN') {
      throw new BadRequestException('Built-in tools cannot be edited');
    }
    if (tool.name !== dto.name) {
      await this.assertNameAvailable(organizationId, dto.name);
    }
    this.assertSourceFields(dto);
    return this.prisma.aiTool.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        source: dto.source,
        parameters: dto.parameters as object,
        // HTTP
        httpMethod: dto.httpMethod?.toUpperCase(),
        httpUrl: dto.httpUrl,
        httpHeaders: (dto.httpHeaders as object) ?? {},
        httpBodyTemplate: dto.httpBodyTemplate,
        responseMap: (dto.responseMap as object) ?? null,
        // SQL
        sqlConnectionRef: dto.sqlConnectionRef,
        sqlQuery: dto.sqlQuery,
        sqlParamMap: (dto.sqlParamMap as object) ?? null,
        sqlReadOnly: dto.sqlReadOnly ?? true,
        sqlMaxRows: dto.sqlMaxRows ?? 50,
        timeoutMs: dto.timeoutMs ?? 15000,
        isActive: dto.isActive ?? true,
      },
    });
  }

  private assertSourceFields(dto: UpsertCustomToolDto) {
    if (dto.source === 'CUSTOM_HTTP') {
      if (!dto.httpMethod || !dto.httpUrl) {
        throw new BadRequestException(
          'CUSTOM_HTTP requires httpMethod and httpUrl',
        );
      }
    } else if (dto.source === 'CUSTOM_SQL') {
      if (!dto.sqlConnectionRef || !dto.sqlQuery) {
        throw new BadRequestException(
          'CUSTOM_SQL requires sqlConnectionRef and sqlQuery',
        );
      }
    }
  }

  async softDelete(organizationId: string, id: string) {
    const tool = await this.findOne(organizationId, id);
    if (tool.source === 'BUILTIN') {
      throw new BadRequestException('Built-in tools cannot be deleted');
    }
    await this.prisma.aiTool.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async assertNameAvailable(organizationId: string, name: string) {
    // Custom tools share the namespace with built-ins (org=null) so the LLM
    // doesn't see two functions with the same name.
    const clash = await this.prisma.aiTool.findFirst({
      where: {
        name,
        deletedAt: null,
        OR: [{ organizationId: null }, { organizationId }],
      },
    });
    if (clash) {
      throw new BadRequestException(
        `Tool name "${name}" já está em uso (built-in ou custom).`,
      );
    }
  }
}
