import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
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

  @ApiPropertyOptional({ description: 'Calendário Google (default primary)' })
  @IsOptional()
  @IsString()
  calendarId?: string;

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

class UpdateCalendarEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  channelId?: string;

  @ApiProperty()
  @IsString()
  calendarId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startIso?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endIso?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  attendeeEmails?: string[];

  @ApiPropertyOptional()
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

  @Get('calendars')
  @ApiOperation({ summary: 'Lista calendários Google selected da conta' })
  calendars(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('channelId') channelId?: string,
  ) {
    return this.calendar.listCalendars(orgId, access, channelId);
  }

  @Get('events')
  @ApiOperation({ summary: 'Lista eventos de todos os calendários selected' })
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
  @ApiOperation({ summary: 'Cria evento (+ Meet por padrão) no calendário escolhido' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: CreateCalendarEventDto,
  ) {
    return this.calendar.createEvent(orgId, access, dto);
  }

  @Patch('events/:eventId')
  @ApiOperation({ summary: 'Atualiza evento no Google (espelha na hora)' })
  update(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    return this.calendar.updateEvent(orgId, access, { ...dto, eventId });
  }

  @Delete('events/:eventId')
  @ApiOperation({ summary: 'Apaga evento no Google' })
  remove(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('eventId') eventId: string,
    @Query('calendarId') calendarId: string,
    @Query('channelId') channelId?: string,
    @Query('notify') notify?: string,
  ) {
    return this.calendar.deleteEvent(orgId, access, {
      channelId,
      calendarId,
      eventId,
      notify: notify !== '0' && notify !== 'false',
    });
  }
}
