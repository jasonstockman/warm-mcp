import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const CONTENT_LENGTH_HEADER = 'content-length:';

type ClientFraming = 'content-length' | 'jsonl';

interface ParsedMessage {
  framing: ClientFraming;
  message: JSONRPCMessage;
}

export class AdaptiveStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private clientFraming: ClientFraming | null = null;
  private closed = false;
  private started = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('AdaptiveStdioTransport already started');
    }

    this.started = true;
    this.stdin.on('data', this.handleData);
    this.stdin.on('error', this.handleError);
    this.stdin.on('end', this.handleEnd);
    this.stdin.resume();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stdin.off('data', this.handleData);
    this.stdin.off('error', this.handleError);
    this.stdin.off('end', this.handleEnd);
    this.stdin.pause();
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const json = JSON.stringify(message);
    const framing = this.clientFraming ?? 'content-length';
    const payload =
      framing === 'jsonl'
        ? `${json}\n`
        : `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;

    await new Promise<void>((resolve) => {
      if (this.stdout.write(payload)) {
        resolve();
        return;
      }

      this.stdout.once('drain', resolve);
    });
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    this.processBuffer();
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly handleEnd = (): void => {
    void this.close();
  };

  private processBuffer(): void {
    while (true) {
      try {
        this.trimLeadingNewlines();

        const parsed = this.readMessage();
        if (parsed === null) {
          return;
        }

        this.clientFraming ??= parsed.framing;
        this.onmessage?.(parsed.message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }

  private trimLeadingNewlines(): void {
    while (this.buffer.length > 0) {
      if (this.buffer[0] === 0x0a) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      if (this.buffer.length > 1 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
        this.buffer = this.buffer.subarray(2);
        continue;
      }

      return;
    }
  }

  private readMessage(): ParsedMessage | null {
    const framing = this.clientFraming ?? this.detectFraming();
    if (framing === null) {
      return null;
    }

    return framing === 'content-length'
      ? this.readContentLengthMessage()
      : this.readJsonLineMessage();
  }

  private detectFraming(): ClientFraming | null {
    if (this.buffer.length === 0) {
      return null;
    }

    const preview = this.buffer
      .subarray(0, Math.min(this.buffer.length, 32))
      .toString('utf8')
      .toLowerCase();

    if (preview.startsWith(CONTENT_LENGTH_HEADER)) {
      return 'content-length';
    }

    if (preview.startsWith('{') || preview.startsWith('[')) {
      return 'jsonl';
    }

    const newlineIndex = this.buffer.indexOf(0x0a);
    if (newlineIndex === -1) {
      return null;
    }

    const firstLine = this.buffer.toString('utf8', 0, newlineIndex).replace(/\r$/, '').trimStart();
    if (firstLine.toLowerCase().startsWith(CONTENT_LENGTH_HEADER)) {
      return 'content-length';
    }

    if (firstLine.startsWith('{') || firstLine.startsWith('[')) {
      return 'jsonl';
    }

    throw new Error(`Unsupported MCP stdio framing: ${JSON.stringify(firstLine.slice(0, 80))}`);
  }

  private readJsonLineMessage(): ParsedMessage | null {
    const newlineIndex = this.buffer.indexOf(0x0a);
    if (newlineIndex === -1) {
      return null;
    }

    const rawLine = this.buffer.toString('utf8', 0, newlineIndex).replace(/\r$/, '');
    this.buffer = this.buffer.subarray(newlineIndex + 1);

    if (rawLine.trim() === '') {
      return this.readMessage();
    }

    return {
      framing: 'jsonl',
      message: JSON.parse(rawLine) as JSONRPCMessage,
    };
  }

  private readContentLengthMessage(): ParsedMessage | null {
    const headerBoundary = this.findHeaderBoundary();
    if (headerBoundary === null) {
      return null;
    }

    const { bodyStart, headerEnd } = headerBoundary;
    const headerText = this.buffer.toString('utf8', 0, headerEnd);
    const contentLength = this.parseContentLength(headerText);

    if (this.buffer.length < bodyStart + contentLength) {
      return null;
    }

    const bodyText = this.buffer.toString('utf8', bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.subarray(bodyStart + contentLength);

    return {
      framing: 'content-length',
      message: JSON.parse(bodyText) as JSONRPCMessage,
    };
  }

  private findHeaderBoundary(): { bodyStart: number; headerEnd: number } | null {
    const crlfBoundary = this.buffer.indexOf('\r\n\r\n');
    if (crlfBoundary !== -1) {
      return {
        bodyStart: crlfBoundary + 4,
        headerEnd: crlfBoundary,
      };
    }

    const lfBoundary = this.buffer.indexOf('\n\n');
    if (lfBoundary !== -1) {
      return {
        bodyStart: lfBoundary + 2,
        headerEnd: lfBoundary,
      };
    }

    return null;
  }

  private parseContentLength(headerText: string): number {
    const headers = headerText.split(/\r?\n/);

    for (const header of headers) {
      const separatorIndex = header.indexOf(':');
      if (separatorIndex === -1) {
        continue;
      }

      const name = header.slice(0, separatorIndex).trim().toLowerCase();
      if (name !== 'content-length') {
        continue;
      }

      const value = Number.parseInt(header.slice(separatorIndex + 1).trim(), 10);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid Content-Length header: ${header}`);
      }

      return value;
    }

    throw new Error('Missing Content-Length header');
  }
}
