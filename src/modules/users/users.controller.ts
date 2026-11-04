import {
  Controller,
  Get,
  Patch,
  Put,
  Delete,
  Param,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CurrentUser, CurrentOrg, CurrentChannelAccess } from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.service.updateProfile(userId, dto);
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change current user password' })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.service.changePassword(userId, dto);
  }

  @Get('me/preferences')
  @UseGuards(OrgGuard)
  @ApiOperation({ summary: 'Get current user preferences (per organization)' })
  getPreferences(
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.getPreferences(userId, orgId);
  }

  @Patch('me/preferences')
  @UseGuards(OrgGuard)
  @ApiOperation({
    summary: 'Shallow-merge patch into current user preferences (per organization)',
  })
  updatePreferences(
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.service.updatePreferences(userId, orgId, dto.preferences);
  }

  @Put('me/pinned-conversations/:conversationId')
  @UseGuards(OrgGuard)
  pin(@CurrentUser('id') userId: string, @CurrentOrg('id') orgId: string,
    @Param('conversationId') id: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.setPinned(userId, orgId, id, true, access);
  }

  @Delete('me/pinned-conversations/:conversationId')
  @UseGuards(OrgGuard)
  unpin(@CurrentUser('id') userId: string, @CurrentOrg('id') orgId: string,
    @Param('conversationId') id: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.setPinned(userId, orgId, id, false, access);
  }
}
