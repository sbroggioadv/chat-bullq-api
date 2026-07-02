import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * Módulo de provisionamento de tenants.
 *
 * Hoje só expõe o TenantProvisioningService pro script CLI. Registre em
 * `AppModule.imports` quando o Aquecia adicionar o endpoint self-service/
 * admin — o service já é injetável e DI-ready.
 *
 * AQUECIA (extensões previstas):
 * - ProvisioningController (POST /admin/tenants) com guard de super-admin/reseller.
 * - BillingModule: gate de plano/quota antes de provisionar.
 * - AccountModule: vincular tenant a uma conta reseller (account_id em settings).
 *
 * PrismaService vem do PrismaModule (@Global). OrganizationsService vem
 * do OrganizationsModule (exportado) — reusa o fluxo de convite existente.
 */
@Module({
  imports: [OrganizationsModule],
  providers: [TenantProvisioningService],
  exports: [TenantProvisioningService],
})
export class ProvisioningModule {}
