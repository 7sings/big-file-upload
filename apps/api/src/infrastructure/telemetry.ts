export interface Logger {
  info(data: Record<string, unknown>): void;
  warn(data: Record<string, unknown>): void;
  error(data: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (data) => console.info(JSON.stringify({ level: 'info', ...data })),
  warn: (data) => console.warn(JSON.stringify({ level: 'warn', ...data })),
  error: (data) => console.error(JSON.stringify({ level: 'error', ...data })),
};

export type TelemetryLabels = Record<string, string | number | boolean | undefined>;

/** 仅收集低基数业务事件；调用方不得传入邮箱、IP、文件名、URL 或验证码。 */
export class Telemetry {
  constructor(private readonly logger: Logger) {}
  event(name: string, labels: TelemetryLabels = {}) {
    const safe = Object.fromEntries(
      Object.entries(labels).filter(([, value]) => value !== undefined),
    );
    this.logger.info({ event: name, ...safe });
  }
}
