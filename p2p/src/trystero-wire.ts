import { trysteroOptions } from "./storage.ts";
import type { Wire } from "./wire.ts";

/** Product transport. Peers meet on public Nostr relays. The fragment secret is the room password. */
export async function connectTrystero(roomId: string, secret: string): Promise<Wire> {
  const { joinRoom, selfId } = await import("trystero");
  const room = joinRoom(trysteroOptions(secret), roomId);
  const act = room.makeAction("m");
  let message: (from: string, body: unknown) => void = () => undefined;
  let join: (peerId: string) => void = () => undefined;
  let leave: (peerId: string) => void = () => undefined;
  act.onMessage = (body, ctx) => message(ctx.peerId, body);
  room.onPeerJoin = (peerId) => join(peerId);
  room.onPeerLeave = (peerId) => leave(peerId);
  return {
    peerId: selfId,
    send(to: string, body: unknown): void {
      if (to === "*") void act.send(body);
      else void act.send(body, { target: to });
    },
    onMessage(fn: (from: string, body: unknown) => void): void {
      message = fn;
    },
    onJoin(fn: (peerId: string) => void): void {
      join = fn;
    },
    onLeave(fn: (peerId: string) => void): void {
      leave = fn;
    },
    close(): void {
      room.leave();
    },
  };
}
