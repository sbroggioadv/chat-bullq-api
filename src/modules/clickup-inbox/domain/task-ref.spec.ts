import { extrairTaskRef } from './task-ref';

describe('extrairTaskRef', () => {
  it('aceita id cru e URL https do ClickUp', () => {
    expect(extrairTaskRef('abc-123')).toBe('abc-123');
    expect(extrairTaskRef('  https://app.clickup.com/t/abc-123  ')).toBe('abc-123');
    expect(extrairTaskRef('https://app.clickup.com/t/team-workspace-1/abc-123')).toBe('abc-123');
  });

  it('recusa http, host estranho e lixo', () => {
    expect(extrairTaskRef('http://app.clickup.com/t/abc-123')).toBeNull();
    expect(extrairTaskRef('https://evil.example/t/abc-123')).toBeNull();
    expect(extrairTaskRef('not a ref!!')).toBeNull();
    expect(extrairTaskRef('')).toBeNull();
  });
});
