import { ToolRegistry } from './tool-registry.service';
import { ToolContext } from './tool.types';

describe('isolamento de ferramentas com credenciais globais', () => {
  const names = ['consultarClickUpCliente', 'consultarN8nCliente', 'listarReunioesCliente', 'lerTranscricaoReuniao', 'agendarReuniao'];
  const ctx = { organizationId: 'org-a' } as ToolContext;
  function setup(allowedOrg?: string) {
    const tools = ['reply', 'transfer', 'tag', 'list', 'delegate', 'handBack', 'pitch', 'bonus', 'members', ...names].map(name => ({ name, execute: jest.fn().mockResolvedValue({ output: { ok: true } }) }));
    const config = { get: (key: string) => key === 'CLIENT_OPS_ORGANIZATION_ID' ? allowedOrg : undefined };
    const registry = new (ToolRegistry as any)(config, ...tools) as ToolRegistry;
    return { registry, tools };
  }
  it.each(names)('%s recusa outra organização e configuração ausente antes do provedor', async name => {
    for (const org of [undefined, 'org-b']) {
      const { registry, tools } = setup(org);
      expect(await registry.get(name).execute({}, ctx)).toEqual({ output: { ok: false, error: 'Esta ferramenta não está disponível neste espaço.' } });
      expect(tools.find(t => t.name === name)!.execute).not.toHaveBeenCalled();
    }
  });
  it.each(names)('%s mantém a execução da organização autorizada', async name => {
    const { registry, tools } = setup('org-a');
    expect(await registry.get(name).execute({}, ctx)).toEqual({ output: { ok: true } });
    expect(tools.find(t => t.name === name)!.execute).toHaveBeenCalledWith({}, ctx);
  });
});
