// Type declarations for the zero-dependency fixture server (consumed by unit tests).
export function livePlaylist(kind: 'ts' | 'fmp4', variant: string, windowSec: number, nowMs?: number, epochMs?: number): string | null;
export function startServer(opts?: { port?: number; host?: string }): Promise<import('node:http').Server>;
