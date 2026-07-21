import type { FastifyBaseLogger } from 'fastify';

export type TelemetryLabels = Record<string, string | number | boolean | undefined>;

/** 仅收集低基数业务事件；调用方不得传入邮箱、IP、文件名、URL 或验证码。 */
export class Telemetry {
  private readonly counters = new Map<string, number>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  event(name: string, labels: TelemetryLabels = {}) {
    const safe = Object.fromEntries(Object.entries(labels).filter(([, value]) => value !== undefined));
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
    this.logger.info({ event: name, ...safe }, 'business event');
  }

  snapshot() { return Object.fromEntries(this.counters); }
}
