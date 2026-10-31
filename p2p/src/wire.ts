export interface Wire {
  peerId: string;
  send(to: string, body: unknown): void;
  onMessage(fn: (from: string, body: unknown) => void): void;
  onJoin(fn: (peerId: string) => void): void;
  onLeave(fn: (peerId: string) => void): void;
  close(): void;
}
