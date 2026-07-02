import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Headers,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiProvider, OrgRole } from '@prisma/client';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CredentialTestThrottleGuard } from './credential-test.throttle.guard';
import { UpdateRoutingDto } from './dto/update-routing.dto';
import { UpsertCredentialDto } from './dto/upsert-credential.dto';
import { OrgCredentialsService } from './org-credentials.service';

@ApiTags('Organization AI Credentials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations/current/credentials')
export class OrgCredentialsController {
  constructor(private readonly service: OrgCredentialsService) {}

  @Get()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'List masked AI credentials for the current org' })
  list(@CurrentOrg('id') organizationId: string) {
    return this.service.listMasked(organizationId);
  }

  @Put(':provider')
  @Roles(OrgRole.OWNER)
  @ApiOperation({ summary: 'Create or update API key for a provider' })
  upsert(
    @Param('provider', new ParseEnumPipe(AiProvider)) provider: AiProvider,
    @Body() dto: UpsertCredentialDto,
    @CurrentOrg('id') organizationId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.service.upsert(
      organizationId,
      provider,
      dto.apiKey,
      userId,
      { ip, userAgent },
      dto.baseUrl,
    );
  }

  @Delete(':provider')
  @Roles(OrgRole.OWNER)
  @ApiOperation({ summary: 'Delete API key for a provider' })
  remove(
    @Param('provider', new ParseEnumPipe(AiProvider)) provider: AiProvider,
    @CurrentOrg('id') organizationId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.service.remove(organizationId, provider, userId, {
      ip,
      userAgent,
    });
  }

  /**
   * Rate-limited: max 10 testes por minuto por org. Evita abuse contra
   * APIs externas (cada teste é uma round-trip real).
   */
  @Post(':provider/test')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @UseGuards(CredentialTestThrottleGuard)
  @ApiOperation({ summary: 'Test connection for a provider credential' })
  test(
    @Param('provider', new ParseEnumPipe(AiProvider)) provider: AiProvider,
    @CurrentOrg('id') organizationId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.service.test(organizationId, provider, userId, {
      ip,
      userAgent,
    });
  }
}

@ApiTags('Organization AI Capability Routing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations/current/capability-routing')
export class OrgCapabilityRoutingController {
  constructor(private readonly service: OrgCredentialsService) {}

  @Get()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'List current capability routing for the org' })
  list(@CurrentOrg('id') organizationId: string) {
    return this.service.listRouting(organizationId);
  }

  @Patch()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Batch update capability routing' })
  update(
    @Body() dto: UpdateRoutingDto,
    @CurrentOrg('id') organizationId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.service.updateRouting(
      organizationId,
      dto.entries,
      userId,
      { ip, userAgent },
    );
  }
}
