export class ErrorLimiter {
  private lastMessage = "";
  private lastAt = 0;

  constructor(private readonly windowMs = 2500) {}

  shouldShow(message: string, now = Date.now()): boolean {
    if (message === this.lastMessage && now - this.lastAt < this.windowMs) return false;
    this.lastMessage = message;
    this.lastAt = now;
    return true;
  }
}
