import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MessageDirection } from '@prisma/client';
import { HermesWhatsappMcpService } from './hermes-whatsapp-mcp.service';

describe('HermesWhatsappMcpService', () => {
  const feed = {
    getFeed: jest.fn(),
    getConversation: jest.fn(),
    getHealth: jest.fn(),
  };
  const config = { get: jest.fn() };
  let service: HermesWhatsappMcpService;
  let client: Client;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new HermesWhatsappMcpService(feed as any, config as any);
    client = new Client({ name: 'hermes-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = service.createServer('org-1', new Set(['channel-1']));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => client.close());

  it('should list exactly three read-only tools with safety annotations', async () => {
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      'list_whatsapp_messages',
      'get_whatsapp_conversation',
      'get_whatsapp_feed_health',
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        }),
      );
      expect(tool.annotations?.title).toEqual(expect.any(String));
    }
  });

  it('should call the feed with the authenticated tenant and channel scope', async () => {
    feed.getFeed.mockResolvedValue({
      schema: 'bullq.hermes.whatsapp-feed.v1',
      generated_at: '2026-07-13T18:00:00.000Z',
      next_cursor: null,
      has_more: false,
      messages: [],
    });

    const result = await client.callTool({
      name: 'list_whatsapp_messages',
      arguments: {
        limit: 25,
        directions: [MessageDirection.INBOUND],
      },
    });

    expect(feed.getFeed).toHaveBeenCalledWith('org-1', new Set(['channel-1']), {
      cursor: undefined,
      limit: 25,
      directions: [MessageDirection.INBOUND],
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('should call conversation context through the same tenant boundary', async () => {
    feed.getConversation.mockResolvedValue(null);

    await client.callTool({
      name: 'get_whatsapp_conversation',
      arguments: { conversation_id: 'conv-cross-tenant', message_limit: 20 },
    });

    expect(feed.getConversation).toHaveBeenCalledWith(
      'org-1',
      new Set(['channel-1']),
      'conv-cross-tenant',
      20,
    );
  });

  it('should expose health without message bodies', async () => {
    feed.getHealth.mockResolvedValue({
      schema: 'bullq.hermes.whatsapp-feed-health.v1',
      generated_at: '2026-07-13T18:00:00.000Z',
      total_messages: 10,
      inbound_messages: 7,
      outbound_messages: 3,
      latest_ingested_at: '2026-07-13T17:59:00.000Z',
      freshness_seconds: 60,
    });

    const result = await client.callTool({ name: 'get_whatsapp_feed_health' });

    expect(feed.getHealth).toHaveBeenCalledWith('org-1', new Set(['channel-1']));
    expect(JSON.stringify(result)).not.toContain('content.text');
  });

  it('should reject an invalid Origin with a plain JSON-RPC 403 response', async () => {
    config.get.mockImplementation((key: string, fallback?: string) =>
      key === 'HERMES_MCP_ALLOWED_ORIGINS' ? 'https://hermes.example' : fallback,
    );
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    await service.handleHttpRequest(
      { headers: { origin: 'https://attacker.example' } } as any,
      { status } as any,
      'org-1',
      new Set(['channel-1']),
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin header' },
      id: null,
    });
  });
});
