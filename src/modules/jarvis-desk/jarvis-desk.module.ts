import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AiProvidersModule } from '../ai-agents/providers/providers.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WatchdogModule } from '../routing/watchdog/watchdog.module';
import { JarvisDeskController } from './jarvis-desk.controller';
import { JarvisDeskRunner } from './jarvis-desk.runner';
import { JarvisDeskService } from './jarvis-desk.service';
import { JarvisDeskTools } from './jarvis-desk.tools';

@Module({
  imports: [PrismaModule, AiProvidersModule, RealtimeModule, WatchdogModule],
  controllers: [JarvisDeskController],
  providers: [JarvisDeskService, JarvisDeskTools, JarvisDeskRunner],
  exports: [JarvisDeskService, JarvisDeskRunner],
})
export class JarvisDeskModule {}
