export const MESSAGE_STREAM_GRACE_MS = 120_000;

/** Tracks liveness independently of inbound traffic, which can be legitimately quiet. */
export class MessageStreamHealth {
  private lastHeartbeatAt: number;
  private recovering = false;

  constructor(now = Date.now()) {
    this.lastHeartbeatAt = now;
  }

  heartbeat(at = Date.now()) {
    this.lastHeartbeatAt = at;
  }

  needsReconnect(now = Date.now()) {
    if (this.recovering || now - this.lastHeartbeatAt < MESSAGE_STREAM_GRACE_MS) return false;
    this.recovering = true;
    return true;
  }
}
