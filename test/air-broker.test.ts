import { describe, expect, it, vi } from "vitest";
import {
  AirBrokerError,
  createAirBroker,
  readSessionCookie,
  type BrokerWebSocket,
} from "../src/air-broker.js";
import { handleRequest } from "../src/index.js";

const BASE = "https://broker.example";
const ACCESS_CODE = "secret-code";
const SESSION = "payload.sig%2Bencoded";

function env(overrides: Partial<Env> = {}): Env {
  return {
    AIR_BROKER_URL: BASE,
    AIR_BROKER_ACCESS_CODE: ACCESS_CODE,
    ...overrides,
  };
}

function sessionHeaders(): Headers {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `SESSION=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`,
  );
  return headers;
}

function jsonResponse(body: unknown, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

class FakeSocket implements BrokerWebSocket {
  sent: string[] = [];
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {
    message: [],
    close: [],
    error: [],
  };
  onPublish: ((message: {
    topic: string;
    payload: { to: string; content: string; req_id: string };
  }) => void) | undefined;

  accept(): void {}

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as {
      action?: string;
      topic?: string;
      payload?: { to: string; content: string; req_id: string };
    };
    if (message.action === "publish" && message.topic && message.payload) {
      this.onPublish?.({
        topic: message.topic,
        payload: message.payload,
      });
    }
  }

  close(): void {
    for (const listener of [...(this.listeners.close ?? [])]) listener({});
  }

  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void {
    this.listeners[type]?.push(listener);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data });
  }
}

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(input, init);
  };
  return { calls, fetchImpl };
}

describe("readSessionCookie", () => {
  it("reads the SESSION value the live worker sets", () => {
    expect(readSessionCookie(sessionHeaders())).toBe(SESSION);
  });
});

describe("air-broker client", () => {
  it("lists devices with a fresh access-code session", async () => {
    const { calls, fetchImpl } = installFetch((_input, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: true }, 200, sessionHeaders());
      return jsonResponse([
        { device_id: "185", status: "online", last_seen: 1, meta: null },
      ]);
    });

    const devices = await createAirBroker(
      { baseUrl: `${BASE}/`, accessCode: ACCESS_CODE },
      { fetch: fetchImpl },
    ).listDevices();

    expect(devices).toEqual([
      { device_id: "185", status: "online", last_seen: 1, meta: null },
    ]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/auth", "/devices"]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: ACCESS_CODE });
    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.get("cookie")).toBe(`SESSION=${SESSION}`);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("logs in again once when the live worker rejects the session", async () => {
    let devices = 0;
    const { calls, fetchImpl } = installFetch((_input, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: true }, 200, sessionHeaders());
      devices += 1;
      if (devices === 1) return new Response("Unauthorized", { status: 401 });
      return jsonResponse([]);
    });

    await createAirBroker(
      { baseUrl: BASE, accessCode: ACCESS_CODE },
      { fetch: fetchImpl },
    ).listDevices();

    expect(calls.filter((call) => new URL(call.url).pathname === "/auth")).toHaveLength(2);
    expect(calls.filter((call) => new URL(call.url).pathname === "/devices")).toHaveLength(2);
  });

  it("does not call list routes when the access code is rejected", async () => {
    const { calls, fetchImpl } = installFetch(() => jsonResponse({ ok: false }, 401));
    await expect(
      createAirBroker({ baseUrl: BASE, accessCode: ACCESS_CODE }, { fetch: fetchImpl }).listDevices(),
    ).rejects.toMatchObject({ status: 401, code: "auth" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/auth"]);
  });

  it("falls back from /contacts/:device to /contacts?device=", async () => {
    const { calls, fetchImpl } = installFetch((input, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: true }, 200, sessionHeaders());
      const url = new URL(String(input));
      if (url.pathname === "/contacts/dev001") return new Response("nope", { status: 404 });
      expect(url.pathname).toBe("/contacts");
      expect(url.searchParams.get("device")).toBe("dev001");
      return jsonResponse([{ number: "555", name: null, last_seen: 2 }]);
    });

    const contacts = await createAirBroker(
      { baseUrl: BASE, accessCode: ACCESS_CODE },
      { fetch: fetchImpl },
    ).listContacts("dev001");

    expect(contacts).toEqual([{ number: "555", name: null, last_seen: 2 }]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/auth",
      "/contacts/dev001",
      "/auth",
      "/contacts",
    ]);
  });

  it("refuses to follow an auth redirect", async () => {
    const { calls, fetchImpl } = installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" },
        }),
    );
    await expect(
      createAirBroker({ baseUrl: BASE, accessCode: ACCESS_CODE }, { fetch: fetchImpl }).listDevices(),
    ).rejects.toBeInstanceOf(AirBrokerError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/auth`);
  });

  it("publishes send_sms on the existing command topic and waits for the receipt", async () => {
    const socket = new FakeSocket();
    socket.onPublish = (message) => {
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: "air780e/response/other",
          payload: { status: "success", req_id: message.payload.req_id },
        }),
      );
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: `air780e/response/185`,
          payload: { status: "success", req_id: "someone-else", to: "555", message: "SMS sent" },
        }),
      );
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: `air780e/response/185`,
          payload: {
            status: "success",
            to: message.payload.to,
            message: "SMS sent",
            req_id: message.payload.req_id,
          },
        }),
      );
    };
    const { calls, fetchImpl } = installFetch(() => jsonResponse({ ok: true }, 200, sessionHeaders()));
    let connected: { url: string; headers: Headers } | undefined;

    const result = await createAirBroker(
      { baseUrl: BASE, accessCode: ACCESS_CODE },
      {
        fetch: fetchImpl,
        connectWebSocket: async (input) => {
          connected = input;
          return socket;
        },
      },
    ).sendSms({ deviceId: "185", to: "5551234", content: "hello" });

    expect(new URL(connected?.url ?? "").pathname).toBe("/ws");
    expect(new URL(connected?.url ?? "").search).toBe("");
    expect(connected?.headers.get("cookie")).toBe(`SESSION=${SESSION}`);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/auth"]);
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      action: "subscribe",
      topic: "air780e/response/185",
    });
    const published = JSON.parse(socket.sent[1] ?? "") as {
      action: string;
      topic: string;
      payload: { command: string; to: string; content: string; req_id: string };
    };
    expect(published.action).toBe("publish");
    expect(published.topic).toBe("air780e/command/185");
    expect(published.payload.command).toBe("send_sms");
    expect(published.payload.to).toBe("5551234");
    expect(published.payload.content).toBe("hello");
    expect(published.payload.req_id).toBe(result.reqId);
    expect(result.receipt).toMatchObject({ status: "success", req_id: result.reqId });
  });

  it("accepts a rate-limit receipt that has no req_id", async () => {
    const socket = new FakeSocket();
    socket.onPublish = () => {
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: "air780e/response/185",
          payload: { status: "fail", message: "该设备短信次数已达上限" },
        }),
      );
    };

    const result = await createAirBroker(
      { baseUrl: BASE, accessCode: ACCESS_CODE },
      {
        fetch: installFetch(() => jsonResponse({ ok: true }, 200, sessionHeaders())).fetchImpl,
        connectWebSocket: async () => socket,
      },
    ).sendSms({ deviceId: "185", to: "555", content: "hello" });

    expect(result.receipt.status).toBe("fail");
    expect(result.receipt.req_id).toBeUndefined();
  });

  it("uses the device token on the WebSocket and does not send the access code", async () => {
    const socket = new FakeSocket();
    socket.onPublish = (message) => {
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: "air780e/response/185",
          payload: { status: "success", req_id: message.payload.req_id, message: "SMS sent" },
        }),
      );
    };
    const { calls, fetchImpl } = installFetch(() => {
      throw new Error("device-token send must not call HTTP");
    });
    let connected: { url: string; headers: Headers } | undefined;

    await createAirBroker(
      {
        baseUrl: BASE,
        accessCode: ACCESS_CODE,
        deviceId: "dev001",
        deviceToken: "tokenA",
      },
      {
        fetch: fetchImpl,
        connectWebSocket: async (input) => {
          connected = input;
          return socket;
        },
      },
    ).sendSms({ deviceId: "185", to: "555", content: "hello" });

    expect(calls).toHaveLength(0);
    const url = new URL(connected?.url ?? "");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("device")).toBe("dev001");
    expect(url.searchParams.get("dtoken")).toBe("tokenA");
    expect(connected?.headers.get("cookie")).toBeNull();
    expect(connected?.headers.get("Upgrade")).toBeNull();
  });
});

describe("abot-sms handler", () => {
  it("answers health without calling air-broker", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleRequest(new Request(`${BASE}/health`), env(), {
      fetch: fetchImpl,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "abot-sms" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists contacts for a device through the client", async () => {
    const { fetchImpl } = installFetch((_input, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: true }, 200, sessionHeaders());
      return jsonResponse([{ number: "555", name: "Ada", last_seen: 3 }]);
    });
    const response = await handleRequest(new Request(`${BASE}/contacts/185`), env(), {
      fetch: fetchImpl,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ number: "555", name: "Ada", last_seen: 3 }]);
  });

  it("rejects an SMS body that does not name a device, number, and content", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleRequest(
      new Request(`${BASE}/sms`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "185", to: "", content: "hi" }),
      }),
      env(),
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("submits SMS over the WebSocket protocol", async () => {
    const socket = new FakeSocket();
    socket.onPublish = (message) => {
      socket.emitMessage(
        JSON.stringify({
          action: "publish",
          topic: "air780e/response/185",
          payload: { status: "success", req_id: message.payload.req_id, message: "SMS sent" },
        }),
      );
    };
    const { calls, fetchImpl } = installFetch(() => jsonResponse({ ok: true }, 200, sessionHeaders()));
    const response = await handleRequest(
      new Request(`${BASE}/sms`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "185", to: "555", content: "hello" }),
      }),
      env(),
      {
        fetch: fetchImpl,
        connectWebSocket: async () => socket,
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; req_id: string };
    expect(body.ok).toBe(true);
    expect(body.req_id).toBeTypeOf("string");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/auth"]);
    expect(socket.sent.some((line) => line.includes("https://"))).toBe(false);
  });
});
