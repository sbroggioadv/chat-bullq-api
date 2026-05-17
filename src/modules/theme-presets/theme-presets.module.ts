/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 */

import { Module } from '@nestjs/common';
import { ThemePresetsController } from './theme-presets.controller';
import { ThemePresetsService } from './theme-presets.service';
import { ThemePresetsRepository } from './theme-presets.repository';

@Module({
  controllers: [ThemePresetsController],
  providers: [ThemePresetsService, ThemePresetsRepository],
  exports: [ThemePresetsService],
})
export class ThemePresetsModule {}
