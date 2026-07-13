import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { PublicHermesController } from './public-hermes.controller';

describe('PublicHermesController', () => {
  it('should protect the Hermes endpoints with API key authentication', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PublicHermesController);

    expect(guards).toContain(ApiKeyAuthGuard);
  });

  it('should expose the Streamable HTTP MCP handler as POST', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicHermesController)).toBe('public/hermes');
    expect(Reflect.getMetadata(PATH_METADATA, PublicHermesController.prototype.mcp)).toBe(
      'mcp',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, PublicHermesController.prototype.mcp)).toBe(
      RequestMethod.POST,
    );
  });

  it('should reject GET MCP with a plain JSON-RPC 405 response', () => {
    const writeMcpError = jest.fn();
    const controller = new PublicHermesController({} as any, { writeMcpError } as any);
    const response = {} as any;

    controller.mcpGet(response);

    expect(writeMcpError).toHaveBeenCalledWith(
      response,
      405,
      -32000,
      'Method not allowed',
    );
  });
});
