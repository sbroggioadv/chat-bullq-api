import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import {
  CurrentChannelAccess,
  CurrentOrg,
} from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { CalendarService } from './calendar.service';

class CreateCalendarEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  channelId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  summary!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'ISO start datetime' })
  @IsString()
  startIso!: string;

  @ApiProperty({ description: 'ISO end datetime' })
  @IsString()
  endIso!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  attendeeEmails?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  withMeet?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timeZone?: string;
}

@ApiTags('Calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('status')
  @ApiOperation({ summary: 'Status da Agenda (mesmo Google do E-mail)' })
  status(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.calendar.status(orgId, access);
  }

  @Get('events')
  @ApiOperation({ summary: 'Lista eventos do calendário primary da org' })
  events(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('channelId') channelId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.calendar.listEvents(orgId, access, { channelId, from, to });
  }

  @Post('events')
  @ApiOperation({ summary: 'Cria evento (+ Meet por padrão)' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: CreateCalendarEventDto,
  ) {
    return this.calendar.createEvent(orgId, access, dto);
  }
}
