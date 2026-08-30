import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { McpServerConfig } from "./types.js";

type TransportType = "stdio" | "websocket" | "streamable-http" | "sse";

export class McpClient {
  private client: Client;
  private transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | WebSocketClientTransport
    | null = null;
  private config: McpServerConfig;
  private connected: boolean = false;
  private closed: boolean = false;
  private intentionalClose: boolean = false;
  private closeNotified: boolean = false;

  /** Invoked once when the connection dies unexpectedly (not via disconnect()). */
  onDisconnected?: (error?: Error) => void;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = this.createClient();
  }

  private createClient(): Client {
    return new Client({ name: "pi-mcp-extension", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Suppress close events while connecting: swapping out the previous
    // client or closing failed attempts must not look like a lost connection.
    this.intentionalClose = true;

    if (this.closed) {
      // A closed Client is never reused: reconnect always connects a fresh one.
      this.client = this.createClient();
      this.closed = false;
    }

    try {
      if (this.config.type === "local") {
        this.transport = this.createStdioTransport();
        await this.client.connect(this.transport);
        this.connected = true;
      } else {
        await this.connectWithAutoDetect();
      }
    } catch (error) {
      this.transport = null;
      throw error;
    }

    this.armDisconnectWatch();
  }

  private async connectWithAutoDetect(): Promise<void> {
    if (this.config.type !== "remote") {
      throw new Error("Expected remote config");
    }

    const url = new URL(this.config.url);
    const headers = this.config.headers ? { ...this.config.headers } : undefined;

    // An explicit transport is honored as-is; auto-detect only runs when
    // the config leaves transport unset (ws/wss URLs still imply websocket).
    const explicit = this.createExplicitTransport(url, headers);
    if (explicit) {
      this.transport = explicit;
      await this.client.connect(this.transport);
      this.connected = true;
      return;
    }

    const transports: Array<{ type: TransportType; create: () => any }> = [
      {
        type: "streamable-http",
        create: () => new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined }),
      },
      {
        type: "sse",
        create: () => new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined }),
      },
    ];

    for (const { type, create } of transports) {
      let attemptTimer: NodeJS.Timeout | undefined;
      // Each transport attempt gets its own Client so a failed attempt's state
      // cannot leak into the next one.
      const attemptClient = new Client({ name: "pi-mcp-extension", version: "1.0.0" });
      try {
        const transport = create();
        const connectPromise = attemptClient.connect(transport);
        const timeoutPromise = new Promise<void>((_, reject) => {
          attemptTimer = setTimeout(() => reject(new Error(`Transport ${type} timeout`)), 2000);
          attemptTimer.unref();
        });

        await Promise.race([connectPromise, timeoutPromise]);

        // Swap in the successful client
        await this.client.close().catch(() => {});
        this.client = attemptClient;
        this.transport = transport;
        this.connected = true;
        return;
      } catch {
        await attemptClient.close().catch(() => {});
      } finally {
        clearTimeout(attemptTimer);
      }
    }

    throw new Error("All transport types failed");
  }

  private createExplicitTransport(
    url: URL,
    headers?: Record<string, string>,
  ): StreamableHTTPClientTransport | SSEClientTransport | WebSocketClientTransport | null {
    if (this.config.type !== "remote") {
      return null;
    }

    const httpOptions = { requestInit: headers ? { headers } : undefined };
    switch (this.config.transport) {
      case "websocket":
        return new WebSocketClientTransport(url);
      case "sse":
        return new SSEClientTransport(url, httpOptions);
      case "streamable-http":
        return new StreamableHTTPClientTransport(url, httpOptions);
      default:
        return url.protocol === "ws:" || url.protocol === "wss:" ? new WebSocketClientTransport(url) : null;
    }
  }

  private armDisconnectWatch(): void {
    this.intentionalClose = false;
    this.closeNotified = false;
    this.client.onclose = () => this.handleUnexpectedClose();
    this.client.onerror = (error: Error) => this.handleUnexpectedClose(error);
  }

  private handleUnexpectedClose(error?: Error): void {
    if (this.intentionalClose || this.closeNotified) {
      return;
    }
    this.connected = false;
    this.closed = true;
    this.closeNotified = true;
    this.onDisconnected?.(error);
  }

  private createStdioTransport(): StdioClientTransport {
    if (this.config.type !== "local") {
      throw new Error("Expected local config for stdio transport");
    }

    const [command, ...args] = this.config.command;
    const env: Record<string, string> = {};
    Object.entries({ ...process.env, ...this.config.env }).forEach(([key, value]) => {
      if (value !== undefined) {
        env[key] = value;
      }
    });
    return new StdioClientTransport({
      command,
      args,
      env,
      cwd: this.config.cwd,
      stderr: "ignore",
    });
  }

  async listTools(): Promise<any[]> {
    if (!this.connected) {
      throw new Error("Client not connected");
    }

    const response = await this.client.listTools();
    return response.tools as any[];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.connected) {
      throw new Error("Client not connected");
    }

    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    // Closing from our side must not surface as an unexpected disconnect.
    this.intentionalClose = true;
    try {
      await this.client.close();
    } finally {
      this.transport = null;
      this.connected = false;
      this.closed = true;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }
}
