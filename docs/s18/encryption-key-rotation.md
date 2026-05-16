# ENCRYPTION_KEY rotation runbook — bullq2 S18 Wave 2

**Quando usar**: incident response (compromise suspeito da master key), key strength upgrade, ou auditoria que exija rotation.

**Não usar**: rotação periódica não é exigida por policy do projeto bullq2 (decisão Doc 2026-05-15).

---

## Pré-requisitos

- Acesso ao Coolify (https://187.127.30.142:8000) + token op item
- Acesso ao 1Password vault `Claude-Code-Dev`
- Janela de manutenção ~5-15min (depende de quantas credentials existem)
- Backup pg_dump recente (auto-weekly do schedule `o103oy229jhk3ddvucph18q6`)

## Procedimento

### 1. Gerar nova key

```bash
NEW_KEY=$(openssl rand -hex 32)
echo "$NEW_KEY"  # copiar pra 1Password ANTES de seguir
```

Salvar no 1Password: criar item novo "bullq2 ENCRYPTION_KEY (rotation YYYY-MM-DD)" com o valor. Manter a key antiga em outro item até confirmar sucesso.

### 2. Listar credentials atuais

```sql
-- Via Coolify Postgres terminal
SELECT id, organization_id, provider, key_hint
FROM organization_credentials
ORDER BY organization_id, provider;
```

Salvar o output em `rotation-snapshot-YYYY-MM-DD.txt`.

### 3. Migration in-place (single transaction)

Esta é a parte sensível: a aplicação **fica down durante a migration** (não há fluxo dual-key).

Opção A — Script TypeScript standalone (recomendado):

Criar `scripts/rotate-encryption-key.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { createDecipheriv, createCipheriv, randomBytes } from 'crypto';

const OLD = process.env.OLD_KEY!;
const NEW = process.env.NEW_KEY!;

const prisma = new PrismaClient();

function decrypt(blob: string, hex: string): string {
  const buf = Buffer.from(blob, 'base64');
  const key = Buffer.from(hex, 'hex');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const dec = createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(authTag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

function encrypt(plaintext: string, hex: string): string {
  const key = Buffer.from(hex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, authTag]).toString('base64');
}

async function main() {
  const rows = await prisma.organizationCredential.findMany({
    select: { id: true, encryptedKey: true },
  });
  console.log(`Found ${rows.length} credentials to rotate`);

  for (const row of rows) {
    const plaintext = decrypt(row.encryptedKey, OLD);
    const reencrypted = encrypt(plaintext, NEW);
    await prisma.organizationCredential.update({
      where: { id: row.id },
      data: { encryptedKey: reencrypted },
    });
    console.log(`✓ Rotated ${row.id}`);
  }
  console.log('Done');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
```

### 4. Aplicar

```bash
# Local com DATABASE_URL apontando pra prod
OLD_KEY=$(op read "op://Claude-Code-Dev/bullq2 ENCRYPTION_KEY (old)/credential") \
NEW_KEY=$(op read "op://Claude-Code-Dev/bullq2 ENCRYPTION_KEY (new)/credential") \
DATABASE_URL=$(op read "op://Claude-Code-Dev/bullq2 prod DATABASE_URL/credential") \
npx tsx scripts/rotate-encryption-key.ts
```

### 5. Atualizar env do API em Coolify

```bash
COOLIFY_TOKEN=$(op item get ll5rmrku6zasqpwv2jrme3adue --vault Claude-Code-Dev --fields credential --reveal)
API_UUID=xffcn65kd8nlhuxxabf0p5dj

# PATCH ENCRYPTION_KEY no env
curl -X PATCH "https://187.127.30.142:8000/api/v1/applications/$API_UUID/envs" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"ENCRYPTION_KEY\",\"value\":\"$NEW_KEY\"}"
```

### 6. Restart API container

```bash
curl -X POST "https://187.127.30.142:8000/api/v1/applications/$API_UUID/restart" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

### 7. Smoke test

- `GET /api/v1/health/llm` — retorna 200 ok
- Listar credentials de uma org → keyHint preservado
- Testar conexão de uma credential → status SUCCESS

### 8. Cleanup

Se smoke OK por 24h: arquivar item 1Password da OLD_KEY como "REVOKED YYYY-MM-DD". Não deletar (pode precisar reverter em forensics).

---

## Rollback

Se step 4 falha parcial (ex: half das rows rotacionadas):

1. **NÃO mudar env Coolify ainda**
2. Re-run script com OLD_KEY ainda configurada — script é idempotente: decrypt com OLD funciona em rows não-rotacionadas, decrypt falha (authTag) em rows já-rotacionadas → script aborta com erro claro
3. Identificar IDs falhos no log, investigar manualmente
4. Se necessário: restaurar pg_dump pré-rotation (perde mudanças do dia, comunicar ao Doc)

---

## Por que não rotação automática?

bullq2 é projeto interno sem clientes terceiros. Doc autorizou postura "internal project aceita risco" (memory: `feedback_security_posture_internal_project.md`). Rotação periódica adicionaria complexidade operacional sem ganho proporcional. Reagir a compromise se acontecer.

Para projetos com clientes (futuro), considerar:
- Dual-key window (ler com OLD, escrever com NEW por N dias)
- Schedule rotation Q12 meses
- HSM/KMS-backed master key (AWS KMS, Vault, etc)
