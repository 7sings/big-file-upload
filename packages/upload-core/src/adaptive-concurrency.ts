export class AdaptiveConcurrency {
  private current: number;
  private stableSuccesses = 0;
  constructor(private readonly min = 1, private readonly max = 6, initial = 3) {
    this.current = Math.max(min, Math.min(max, initial));
  }
  get value() { return this.current; }
  onSuccess() {
    this.stableSuccesses += 1;
    if (this.stableSuccesses >= 3 && this.current < this.max) {
      this.current += 1;
      this.stableSuccesses = 0;
    }
    return this.current;
  }
  onCongestion() {
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    this.stableSuccesses = 0;
    return this.current;
  }
}
