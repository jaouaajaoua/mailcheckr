import * as net from "node:net";
import * as tls from "node:tls";

/**
 * Injectable SMTP transport. The probe state machine talks only to this
 * interface, so unit tests drive it with a scripted fake — no live
 * network. The production implementation below uses node:net / node:tls.
 *
 * Both implementations enforce the hard DATA guard at the write layer
 * as defense in depth (the state machine guards too): any attempt to
 * write a DATA command throws DataCommandForbiddenError.
 */

export class DataCommandForbiddenError extends Error {
  constructor(line: string) {
    super(`Refusing to issue the SMTP DATA command (blocked line: ${JSON.stringify(line.slice(0, 32))}). MailCheckr never sends email.`);
    this.name = "DataCommandForbiddenError";
  }
}

export function assertNotDataCommand(line: string): void {
  if (/^\s*DATA(\s|$)/i.test(line)) throw new DataCommandForbiddenError(line);
}

export interface SmtpTransport {
  connect(host: string, port: number): Promise<void>;
  /**
   * The ACTUAL peer IP of the connected socket (net.Socket.remoteAddress),
   * or null when not connected / unavailable. The probe verifies this
   * against the validated resolved IP set immediately after connect —
   * the DNS-rebinding / TOCTOU defense: DNS was checked before connect,
   * but only the socket tells us who we really connected to.
   */
  remoteAddress(): string | null;
  /** Read one CRLF-terminated line (returned without the CRLF). */
  readLine(): Promise<string>;
  /** Write one line (CRLF appended by the transport). */
  writeLine(line: string): Promise<void>;
  /** Upgrade the connected socket to TLS with certificate validation. */
  startTls(servername: string): Promise<void>;
  isSecure(): boolean;
  close(): Promise<void>;
}

export interface NodeSmtpTransportOptions {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export class NodeSmtpTransport implements SmtpTransport {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  private secure = false;
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(options: NodeSmtpTransportOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        const err = new Error(`SMTP connect to ${host}:${port} timed out`) as Error & { code?: string };
        err.code = "ETIMEDOUT";
        reject(err);
      }, this.connectTimeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        this.attach(socket);
        resolve();
      });
    });
  }

  remoteAddress(): string | null {
    // After the STARTTLS upgrade this.socket is the TLSSocket, whose
    // remoteAddress is the same underlying TCP peer.
    return this.socket?.remoteAddress ?? null;
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.pump();
    });
    socket.on("error", (err) => this.failWaiters(err));
    socket.on("close", () => this.failWaiters(new Error("SMTP connection closed while waiting for a reply")));
  }

  private pump(): void {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) return;
      const raw = this.buffer.slice(0, idx + 1);
      this.buffer = this.buffer.slice(idx + 1);
      const line = raw.replace(/\r?\n$/, "");
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        // Unsolicited line: keep it buffered by re-queueing as data.
        this.buffer = raw + this.buffer;
        return;
      }
    }
  }

  private failWaiters(err: Error): void {
    const pending = this.waiters.splice(0);
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  readLine(): Promise<string> {
    // Fast path: a complete line may already be buffered.
    const idx = this.buffer.indexOf("\n");
    if (idx >= 0) {
      const raw = this.buffer.slice(0, idx + 1);
      this.buffer = this.buffer.slice(idx + 1);
      return Promise.resolve(raw.replace(/\r?\n$/, ""));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error("SMTP read timed out") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(err);
      }, this.readTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  writeLine(line: string): Promise<void> {
    assertNotDataCommand(line);
    if (/[\r\n]/.test(line)) throw new Error("Refusing to write an SMTP line containing CR or LF");
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("SMTP transport is not connected"));
      this.socket.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  startTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket instanceof tls.TLSSocket) {
        return reject(new Error("Cannot start TLS: no plain socket available"));
      }
      const plain = this.socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      const secureSocket = tls.connect({ socket: plain, servername, rejectUnauthorized: true });
      const timer = setTimeout(() => {
        secureSocket.destroy();
        reject(new Error("TLS handshake timed out"));
      }, this.readTimeoutMs);
      secureSocket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      secureSocket.once("secureConnect", () => {
        clearTimeout(timer);
        this.secure = true;
        this.attach(secureSocket);
        resolve();
      });
    });
  }

  isSecure(): boolean {
    return this.secure;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.failWaiters(new Error("SMTP transport closed"));
  }
}
