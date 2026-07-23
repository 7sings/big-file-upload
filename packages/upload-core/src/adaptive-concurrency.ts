export class AdaptiveConcurrency {
  private current: number;
  private fastSuccesses = 0;
  private congestionEvents = 0;
  constructor(private readonly min = 1, private readonly max = 6, initial = 2) {
    this.current = Math.max(min, Math.min(max, initial));
  }
  get value() { return this.current; }
  onSuccess(elapsedMs: number) {
    this.congestionEvents = 0;
    if (!Number.isFinite(elapsedMs) || elapsedMs >= 1_000) {
      this.fastSuccesses = 0;
      return this.current;
    }
    this.fastSuccesses += 1;
    if (this.current < 4 && this.fastSuccesses >= 2) this.current = Math.min(4, this.max);
    else if (this.current < 6 && this.fastSuccesses >= 4) this.current = Math.min(6, this.max);
    return this.current;
  }
  onCongestion() {
    this.congestionEvents += 1;
    this.current = this.congestionEvents >= 2 ? this.min : Math.max(this.min, Math.floor(this.current / 2));
    this.fastSuccesses = 0;
    return this.current;
  }
}
