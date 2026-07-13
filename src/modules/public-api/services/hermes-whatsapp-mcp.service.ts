import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MessageDirection } from '@prisma/client';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';
import { HermesWhatsappFeedService } from './hermes-whatsapp-feed.service';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

@Injectable()
export class HermesWhatsappMcpService {
  constructor(
    private readonly feed: HermesWhatsappFeedService,
    private readonly config: ConfigService,
  ) {}

  createServer(organizationId: string, access: ChannelAccess): McpServer {
    const server = new McpServer({ name: 'bullq-hermes', version: '1.0.0' });

    server.registerTool(
      'list_whatsapp_messages',
      {
        title: 'List WhatsApp messages',
        description: 'Lists the incremental BullQ WhatsApp feed using an opaque cursor.',
        inputSchema: {
          cursor: z.string().max(2048).optional(),
          limit: z.number().int().min(1).max(200).default(100),
          directions: z
            .array(z.enum([MessageDirection.INBOUND, MessageDirection.OUTBOUND]))
            .min(1)
            .max(2)
            .optional(),
        },
        annotations: { title: 'List WhatsApp messages', ...READ_ONLY_ANNOTATIONS },
      },
      async ({ cursor, limit, directions }) =>
        this.toolResult(
          await this.feed.getFeed(organizationId, access, {
            cursor,
            limit,
            directions,
          }),
        ),
    );

    server.registerTool(
      'get_whatsapp_conversation',
      {
        title: 'Get WhatsApp conversation',
        description: 'Gets a bounded, read-only message context for one conversation.',
        inputSchema: {
          conversation_id: z.string().min(1).max(256),
          message_limit: z.number().int().min(1).max(50).default(30),
        },
        annotations: { title: 'Get WhatsApp conversation', ...READ_ONLY_ANNOTATIONS },
      },
      async ({ conversation_id, message_limit }) => {
        const result = await this.feed.getConversation(
          organizationId,
          access,
          conversation_id,
          message_limit,
        );
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: 'Conversation not found' }],
            isError: true,
          };
        }
        return this.toolResult(result);
      },
    );

    server.registerTool(
      'get_whatsapp_feed_health',
      {
        title: 'Get WhatsApp feed health',
        description: 'Returns message counts and ingestion freshness without message bodies.',
        annotations: { title: 'Get WhatsApp feed health', ...READ_ONLY_ANNOTATIONS },
      },
      async () => this.toolResult(await this.feed.getHealth(organizationId, access)),
    );

    return server;
  }

  async handleHttpRequest(
    request: Request,
    response: Response,
    organizationId: string,
    access: ChannelAccess,
  ): Promise<void> {
    if (!this.isAllowedOrigin(request.headers.origin)) {
      this.writeMcpError(response, 403, -32000, 'Invalid Origin header');
      return;
    }

    const server = this.createServer(organizationId, access);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }

  private toolResult(value: object) {
    const structuredContent = value as Record<string, unknown>;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent,
    };
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    const configured = this.config.get<string>(
      'HERMES_MCP_ALLOWED_ORIGINS',
      this.config.get<string>('CORS_ORIGIN', ''),
    );
    const allowed = configured
      .split(',')
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    return allowed.includes(origin);
  }

  writeMcpError(
    response: Response,
    status: number,
    code: number,
    message: string,
  ): void {
    response.status(status).json({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    });
  }
}
