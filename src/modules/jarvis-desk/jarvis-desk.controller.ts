import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { JarvisDeskService } from './jarvis-desk.service';

@ApiTags('Jarvis desk')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('jarvis-desk')
export class JarvisDeskController {
  constructor(private readonly desk: JarvisDeskService) {}

  @Get()
  @ApiOperation({
    summary: 'Garante o canal interno do Jarvis e devolve a conversa da mesa',
  })
  async getDesk(@CurrentOrg('id') organizationId: string) {
    return this.desk.ensureDesk(organizationId);
  }
}
