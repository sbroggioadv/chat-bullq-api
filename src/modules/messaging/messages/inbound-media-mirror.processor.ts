import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  INBOUND_MEDIA_MIRROR_QUEUE,
  InboundMediaMirrorService,
  MirrorJobData,
  mirrorBackoffStrategy,
} from './inbound-media-mirror.service';

/** Worker da fila de espelhamento de mídia do Instagram (SPEC-017). */
@Processor(INBOUND_MEDIA_MIRROR_QUEUE, {
  concurrency: 2,
  settings: { backoffStrategy: mirrorBackoffStrategy },
})
export class InboundMediaMirrorProcessor extends WorkerHost {
  constructor(private readonly mirror: InboundMediaMirrorService) {
    super();
  }

  async process(job: Job<MirrorJobData>) {
    const attempts = job.opts.attempts ?? 1;
    return this.mirror.runJob(job.data, {
      isFinalAttempt: job.attemptsMade + 1 >= attempts,
    });
  }
}
