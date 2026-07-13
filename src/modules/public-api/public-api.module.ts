import { Module } from '@nestjs/common';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { PublicHermesController } from './controllers/public-hermes.controller';
import { HermesWhatsappFeedService } from './services/hermes-whatsapp-feed.service';
import { HermesWhatsappMcpService } from './services/hermes-whatsapp-mcp.service';

@Module({
  imports: [AuthModule, DashboardModule],
  controllers: [PublicMeController, PublicDashboardController, PublicHermesController],
  providers: [HermesWhatsappFeedService, HermesWhatsappMcpService],
  exports: [HermesWhatsappFeedService],
})
export class PublicApiModule {}
