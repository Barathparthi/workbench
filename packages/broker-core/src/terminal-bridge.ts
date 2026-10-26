import {
  CloseCodes,
  decodeClientFrame,
  encodeOutput,
  type ClientControl,
  type CloseCode,
  type ServerControl,
} from '@qe/contracts';

import type { PtyChannel } from './ssh-transport.js';

/** The WebSocket as the bridge sees it (the `ws` package in the broker, a fake in tests). */
export interface StreamSocket {
  send(data: Uint8Array | string): void;
  close(code: number, reason?: string): void;
  /** Bytes queued but not yet written to the network (WebSocket backpressure). */
  readonly bufferedAmount: number;
}

export type CloseReason =
  | 'client_closed'
  | 'remote_exited'
  | 'idle_timeout'
  | 'session_expired'
  | 'revoked'
  | 'shutdown'
  | 'protocol_error'
  | 'connect_failed';

export const CLOSE_CODE: Readonly<Record<CloseReason, CloseCode>> = {
  client_closed: CloseCodes.NORMAL,
  remote_exited: CloseCodes.NORMAL,
  idle_timeout: CloseCodes.EXPIRED,
  session_expired: CloseCodes.EXPIRED,
  revoked: CloseCodes.REVOKED,
  shutdown: CloseCodes.SHUTTING_DOWN,
  protocol_error: CloseCodes.PROTOCOL,
  connect_failed: CloseCodes.INTERNAL,
};

export interface BridgeOptions {
  /** No input and no output for this long ends the session. */
  readonly idleMs: number;
  /** Hard end of the session (policy maxSessionSec). */
  readonly expiresAt: Date;
  /** Pause the remote shell while more than this is waiting to be sent to the browser. */
  readonly highWaterBytes?: number;
  readonly lowWaterBytes?: number;
  readonly now?: () => number;
}

export interface BridgeResult {
  readonly reason: CloseReason;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly exitCode: number | null;
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
/** Interrupts go through the PTY as control characters (S4 rule 3): SSH `signal` requests are ignored by sshd. */
const SIGNAL_BYTES: Readonly<Record<string, Uint8Array>> = {
  SIGINT: Uint8Array.of(0x03),
  SIGQUIT: Uint8Array.of(0x1c),
};

/**
 * One remote terminal: browser WebSocket ⇄ SSH PTY (Phase 08 §8.3 steps 7–10). Messages may arrive before the
 * shell is open — they are queued (S3 finding). Closing is idempotent and always reports one result.
 */
export class TerminalBridge {
  private channel: PtyChannel | undefined;
  private readonly queue: ClientControl[] = [];
  private readonly pendingInput: Uint8Array[] = [];
  private closed: BridgeResult | undefined;
  private readonly listeners: ((r: BridgeResult) => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly expiryTimer: ReturnType<typeof setTimeout>;
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private bytesIn = 0;
  private bytesOut = 0;
  private exitCode: number | null = null;
  private readonly now: () => number;

  constructor(
    private readonly socket: StreamSocket,
    private readonly options: BridgeOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.expiryTimer = setTimeout(
      () => {
        this.close('session_expired');
      },
      Math.max(0, options.expiresAt.getTime() - this.now()),
    );
    this.touch();
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  sendControl(message: ServerControl): void {
    if (this.closed === undefined) this.socket.send(JSON.stringify(message));
  }

  /** Feed every WebSocket message here, from the moment the socket is accepted. */
  handleMessage(data: Uint8Array | string, isBinary: boolean): void {
    if (this.closed !== undefined) return;
    const frame = decodeClientFrame(data, isBinary);
    if (frame === undefined) {
      this.close('protocol_error');
      return;
    }
    this.touch();
    if (frame.kind === 'input') {
      this.bytesIn += frame.data.length;
      if (this.channel === undefined) this.pendingInput.push(frame.data);
      else this.channel.write(frame.data);
      return;
    }
    if (this.channel === undefined && frame.message.t !== 'close') {
      this.queue.push(frame.message);
      return;
    }
    this.control(frame.message);
  }

  /** The shell is open: replay what arrived early, then stream. */
  attach(channel: PtyChannel): void {
    if (this.closed !== undefined) {
      channel.end();
      return;
    }
    this.channel = channel;
    channel.onData((data) => {
      this.output(data);
    });
    channel.onClose((code, signal) => {
      this.exitCode = code;
      this.sendControl({ t: 'exit', code, signal });
      this.close('remote_exited');
    });
    for (const message of this.queue.splice(0)) this.control(message);
    for (const data of this.pendingInput.splice(0)) channel.write(data);
  }

  onClosed(listener: (result: BridgeResult) => void): void {
    if (this.closed !== undefined) listener(this.closed);
    else this.listeners.push(listener);
  }

  /** Ends the session once; later calls are no-ops. */
  close(reason: CloseReason, message?: string): void {
    if (this.closed !== undefined) return;
    this.closed = { reason, bytesIn: this.bytesIn, bytesOut: this.bytesOut, exitCode: this.exitCode };
    clearTimeout(this.idleTimer);
    clearTimeout(this.expiryTimer);
    clearInterval(this.drainTimer);
    this.channel?.end();
    try {
      this.socket.close(CLOSE_CODE[reason], message ?? reason);
    } catch {
      // socket already gone
    }
    for (const listener of this.listeners.splice(0)) listener(this.closed);
  }

  private control(message: ClientControl): void {
    switch (message.t) {
      case 'resize':
        this.channel?.setWindow(message.rows, message.cols);
        return;
      case 'signal':
        if (message.signal === 'SIGTERM') this.channel?.end();
        else this.channel?.write(SIGNAL_BYTES[message.signal] ?? Uint8Array.of(0x03));
        return;
      case 'close':
        this.close('client_closed');
        return;
      case 'ack':
        // Clients may acknowledge output; backpressure itself is driven by the socket's buffered amount.
        return;
    }
  }

  private output(data: Buffer): void {
    if (this.closed !== undefined) return;
    this.bytesOut += data.length;
    this.touch();
    for (const frame of encodeOutput(data)) this.socket.send(frame);
    const high = this.options.highWaterBytes ?? HIGH_WATER;
    if (this.socket.bufferedAmount > high && this.drainTimer === undefined) {
      // The browser cannot keep up (e.g. `cat` of a huge file): stop reading from the shell until it drains.
      this.channel?.pause();
      this.drainTimer = setInterval(() => {
        if (this.socket.bufferedAmount <= (this.options.lowWaterBytes ?? LOW_WATER)) {
          clearInterval(this.drainTimer);
          this.drainTimer = undefined;
          this.channel?.resume();
        }
      }, 20);
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close('idle_timeout');
    }, this.options.idleMs);
  }
}
