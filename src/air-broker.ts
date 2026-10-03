/**
 * Client for the live air-broker worker.
 * Speaks only the HTTP and WebSocket API that worker already exposes.
 */

const SMS_TIMEOUT_MS = 20_000;
const ALLOWED_PATHS = new Set(["/auth", "/devices", "/contacts", "/ws"]);

export interface AirBrokerConfig {
  baseUrl: string;
  accessCode?: string;
  deviceId?: string;
  deviceToken?: string;
}

export interface BrokerWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export interface AirBrokerDeps {
  fetch?: typeof fetch;
  connectWebSocket?: (input: {
    url: string;
    headers: Headers;
  }) => Promise<BrokerWebSocket>;
  timeoutMs?: number;
}

export interface SmsReceipt {
  status?: string;
  to?: string;
  message?: string;
  req_id?: string;
}

export class AirBrokerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "AirBrokerError";
    this.status = status;
    this.code = code;
  }
}

export function readSessionCookie(headers: Headers): string | null {
  const lines =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitCombinedSetCookie(headers.get("set-cookie"));
  for (const line of lines) {
    const match = /^SESSION=([^;]*)/i.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

export function createAirBroker(config: AirBrokerConfig, deps: AirBrokerDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const connectWebSocket =
    deps.connectWebSocket ??
    ((input) => connectBrokerWebSocket(input, fetchImpl));
  const timeoutMs = deps.timeoutMs ?? SMS_TIMEOUT_MS;
  const base = parseBaseUrl(config.baseUrl);
  const deviceAuth = deviceCredentials(config);

  return {
    listDevices(): Promise<unknown> {
      return authedJson(fetchImpl, base, config.accessCode, "/devices");
    },

    async listContacts(device: string): Promise<unknown> {
      const encoded = encodeURIComponent(device);
      try {
        return await authedJson(
          fetchImpl,
          base,
          config.accessCode,
          `/contacts/${encoded}`,
        );
      } catch (error) {
        if (!(error instanceof AirBrokerError) || error.code !== "upstream") {
          throw error;
        }
        return authedJson(
          fetchImpl,
          base,
          config.accessCode,
          `/contacts?device=${encoded}`,
        );
      }
    },

    sendSms(input: {
      deviceId: string;
      to: string;
      content: string;
    }): Promise<{ reqId: string; receipt: SmsReceipt }> {
      return publishSendSms({
        fetchImpl,
        connectWebSocket,
        base,
        accessCode: config.accessCode,
        deviceAuth,
        deviceId: input.deviceId,
        to: input.to,
        content: input.content,
        timeoutMs,
      });
    },
  };
}

export async function connectBrokerWebSocket(
  input: { url: string; headers: Headers },
  fetchImpl: typeof fetch = fetch,
): Promise<BrokerWebSocket> {
  const headers = new Headers(input.headers);
  headers.set("Upgrade", "websocket");
  const response = await fetchImpl(input.url, {
    headers,
    redirect: "manual",
  });
  if (response.status === 401) {
    throw new AirBrokerError("air-broker rejected the WebSocket", 401, "auth");
  }
  const socket = response.webSocket;
  if (!socket) {
    throw new AirBrokerError(
      "air-broker did not accept the WebSocket upgrade",
      response.status || 502,
      "ws-upgrade-failed",
    );
  }
  return {
    accept() {
      socket.accept();
    },
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    addEventListener(
      type: "message" | "close" | "error",
      listener: (event: { data?: unknown }) => void,
    ) {
      socket.addEventListener(type, (event: Event) => {
        listener({
          data: "data" in event ? Reflect.get(event, "data") : undefined,
        });
      });
    },
  };
}

function parseBaseUrl(raw: string | undefined): URL {
  if (!raw?.trim()) {
    throw new AirBrokerError("AIR_BROKER_URL is not configured", 500, "config");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AirBrokerError("AIR_BROKER_URL is not a valid URL", 500, "config");
  }
  const localhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new AirBrokerError("AIR_BROKER_URL must use https", 500, "config");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function deviceCredentials(
  config: AirBrokerConfig,
): { deviceId: string; deviceToken: string } | undefined {
  const deviceId = config.deviceId?.trim() ?? "";
  const deviceToken = config.deviceToken?.trim() ?? "";
  if (!deviceId && !deviceToken) return undefined;
  if (!deviceId || !deviceToken) {
    throw new AirBrokerError(
      "AIR_BROKER_DEVICE_ID and AIR_BROKER_DEVICE_TOKEN must both be set",
      500,
      "config",
    );
  }
  return { deviceId, deviceToken };
}

async function authedJson(
  fetchImpl: typeof fetch,
  base: URL,
  accessCode: string | undefined,
  pathAndQuery: string,
): Promise<unknown> {
  const path = pathAndQuery.split("?")[0] ?? pathAndQuery;
  assertAllowedPath(path);
  let response = await sessionGet(fetchImpl, base, accessCode, pathAndQuery);
  if (response.status === 401) {
    response = await sessionGet(fetchImpl, base, accessCode, pathAndQuery);
  }
  if (!response.ok) {
    throw new AirBrokerError(
      `air-broker ${path} returned ${response.status}`,
      response.status,
      "upstream",
    );
  }
  return response.json();
}

async function sessionGet(
  fetchImpl: typeof fetch,
  base: URL,
  accessCode: string | undefined,
  pathAndQuery: string,
): Promise<Response> {
  const cookie = await login(fetchImpl, base, accessCode);
  const url = new URL(pathAndQuery, base);
  return fetchImpl(url, {
    method: "GET",
    headers: { cookie: `SESSION=${cookie}` },
    redirect: "manual",
  });
}

async function login(
  fetchImpl: typeof fetch,
  base: URL,
  accessCode: string | undefined,
): Promise<string> {
  if (!accessCode?.trim()) {
    throw new AirBrokerError(
      "AIR_BROKER_ACCESS_CODE is not configured",
      500,
      "config",
    );
  }
  const response = await fetchImpl(new URL("/auth", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: accessCode.trim() }),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new AirBrokerError("air-broker auth redirected", 502, "auth");
  }
  if (!response.ok) {
    throw new AirBrokerError("air-broker access code was rejected", 401, "auth");
  }
  const cookie = readSessionCookie(response.headers);
  if (!cookie) {
    throw new AirBrokerError(
      "air-broker did not set a SESSION cookie",
      502,
      "auth",
    );
  }
  return cookie;
}

async function publishSendSms(input: {
  fetchImpl: typeof fetch;
  connectWebSocket: NonNullable<AirBrokerDeps["connectWebSocket"]>;
  base: URL;
  accessCode: string | undefined;
  deviceAuth: { deviceId: string; deviceToken: string } | undefined;
  deviceId: string;
  to: string;
  content: string;
  timeoutMs: number;
}): Promise<{ reqId: string; receipt: SmsReceipt }> {
  const url = new URL("/ws", input.base);
  const headers = new Headers();
  if (input.deviceAuth) {
    url.searchParams.set("device", input.deviceAuth.deviceId);
    url.searchParams.set("dtoken", input.deviceAuth.deviceToken);
  } else {
    headers.set(
      "cookie",
      `SESSION=${await login(input.fetchImpl, input.base, input.accessCode)}`,
    );
  }

  const socket = await input.connectWebSocket({
    url: url.toString(),
    headers,
  });
  socket.accept();

  const reqId = crypto.randomUUID();
  const responseTopic = `air780e/response/${input.deviceId}`;
  const commandTopic = `air780e/command/${input.deviceId}`;

  try {
    const receipt = await new Promise<SmsReceipt>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: SmsReceipt) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as SmsReceipt);
      };
      timer = setTimeout(() => {
        finish(
          new AirBrokerError(
            "air-broker did not return an SMS receipt",
            504,
            "timeout",
          ),
        );
      }, input.timeoutMs);

      socket.addEventListener("error", () => {
        finish(new AirBrokerError("air-broker WebSocket failed", 502, "ws"));
      });
      socket.addEventListener("close", () => {
        finish(
          new AirBrokerError(
            "air-broker WebSocket closed before a receipt",
            502,
            "ws",
          ),
        );
      });
      socket.addEventListener("message", (event) => {
        const receipt = parseReceipt(event.data, responseTopic, reqId);
        if (receipt) finish(undefined, receipt);
      });

      socket.send(
        JSON.stringify({ action: "subscribe", topic: responseTopic }),
      );
      socket.send(
        JSON.stringify({
          action: "publish",
          topic: commandTopic,
          payload: {
            command: "send_sms",
            to: input.to,
            content: input.content,
            req_id: reqId,
          },
        }),
      );
    });

    return { reqId, receipt };
  } finally {
    try {
      socket.close();
    } catch {
      // The socket may already be closed after a receipt or an error.
    }
  }
}

function parseReceipt(
  data: unknown,
  responseTopic: string,
  reqId: string,
): SmsReceipt | undefined {
  if (typeof data !== "string") return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(message)) return undefined;
  if (message.action !== "publish" || message.topic !== responseTopic) {
    return undefined;
  }
  if (!isRecord(message.payload)) return undefined;
  const payloadReq = message.payload.req_id;
  if (typeof payloadReq === "string" && payloadReq !== reqId) return undefined;
  return {
    status: typeof message.payload.status === "string" ? message.payload.status : undefined,
    to: typeof message.payload.to === "string" ? message.payload.to : undefined,
    message:
      typeof message.payload.message === "string"
        ? message.payload.message
        : undefined,
    req_id: typeof payloadReq === "string" ? payloadReq : undefined,
  };
}

function assertAllowedPath(path: string): void {
  if (!ALLOWED_PATHS.has(path) && !path.startsWith("/contacts/")) {
    throw new AirBrokerError(`refusing unexpected path ${path}`, 500, "client");
  }
}

function splitCombinedSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*SESSION=)/i);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
