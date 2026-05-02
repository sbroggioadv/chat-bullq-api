import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Tags a conversation with one or more labels. If a tag name doesn't exist
 * in the org yet, it is created. Existing tags are reused.
 */
@Injectable()
export class TagConversationTool implements AiTool {
  private readonly logger = new Logger(TagConversationTool.name);

  readonly name = 'tagConversation';
  readonly description =
    'Apply one or more tags to the current conversation. Use to categorize the request (ex: "billing", "lead-quente", "duvida-tecnica") so it can be filtered/reported on later.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['tags'],
    properties: {
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 40 },
        minItems: 1,
        maxItems: 5,
        description:
          'Tag names (lowercase, kebab-case preferred). New names are auto-created.',
      },
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const raw = Array.isArray(input.tags) ? (input.tags as unknown[]) : [];
    const names = Array.from(
      new Set(
        raw
          .map((t) => String(t).trim().toLowerCase())
          .filter((t) => t.length > 0 && t.length <= 40),
      ),
    );

    if (names.length === 0) {
      return { output: { ok: false, error: 'no valid tag names' } };
    }

    const existing = await this.prisma.tag.findMany({
      where: { organizationId: ctx.organizationId, name: { in: names } },
      select: { id: true, name: true },
    });
    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    const toCreate = names.filter((n) => !existingByName.has(n));

    const created = toCreate.length
      ? await this.prisma.$transaction(
          toCreate.map((name) =>
            this.prisma.tag.create({
              data: { organizationId: ctx.organizationId, name },
              select: { id: true, name: true },
            }),
          ),
        )
      : [];

    const allTags = [...existing, ...created];

    await this.prisma.$transaction(
      allTags.map((tag) =>
        this.prisma.conversationTag.upsert({
          where: {
            conversationId_tagId: {
              conversationId: ctx.conversationId,
              tagId: tag.id,
            },
          },
          create: {
            conversationId: ctx.conversationId,
            tagId: tag.id,
          },
          update: {},
        }),
      ),
    );

    this.logger.log(
      `Agent ${ctx.agentId} tagged conv ${ctx.conversationId} with ${names.join(', ')}`,
    );

    return {
      output: {
        ok: true,
        applied: allTags.map((t) => t.name),
      },
    };
  }
}
