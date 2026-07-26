export class SocketPresence {
  private readonly socketsByUser = new Map<string, Set<string>>();

  add(userId: string, socketId: string): void {
    const sockets = this.socketsByUser.get(userId) ?? new Set<string>();
    sockets.add(socketId);
    this.socketsByUser.set(userId, sockets);
  }

  remove(userId: string, socketId: string): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) this.socketsByUser.delete(userId);
  }

  has(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  ids(userId: string): string[] {
    return [...(this.socketsByUser.get(userId) ?? [])];
  }

  userCount(): number {
    return this.socketsByUser.size;
  }

  socketCount(userId: string): number {
    return this.socketsByUser.get(userId)?.size ?? 0;
  }
}
