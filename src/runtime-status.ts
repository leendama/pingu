export interface RuntimeStatusSnapshot {
  startedAt?: string;
  lastReplyAt?: string;
}

let status: RuntimeStatusSnapshot = {};

export function markAgentStarted(now = new Date()): void {
  status.startedAt = now.toISOString();
}

export function markReplyDelivered(now = new Date()): void {
  status.lastReplyAt = now.toISOString();
}

export function runtimeStatus(): RuntimeStatusSnapshot {
  return { ...status };
}

export function resetRuntimeStatus(): void {
  status = {};
}
