import {
  AirBrokerError,
  createAirBroker,
  type AirBrokerConfig,
  type SmsReceipt,
} from "./air-broker.js";
import { handleMcp, type SmsTools } from "./mcp.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export async function handleRequest(
  request: Request,
  env: Env,
  deps?: Parameters<typeof createAirBroker>[1],
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && (path === "/" || path === "/health")) {
    return Response.json({ ok: true, service: "abot-sms" });
  }

  if (path === "/mcp") {
    if (request.method !== "POST") {
      return Response.json(
        { ok: false, error: "method not allowed" },
        { status: 405, headers: { allow: "POST" } },
      );
    }
    // The gateway always sets this on binding calls; anything without it did not come through the gateway.
    if (!request.headers.get("X-Abot-Owner-Email")?.trim()) {
      return Response.json(
        { ok: false, error: "X-Abot-Owner-Email required" },
        { status: 401 },
      );
    }
    return handleMcp(request, toolsFor(env, deps));
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

function toolsFor(
  env: Env,
  deps: Parameters<typeof createAirBroker>[1],
): SmsTools {
  const broker = () => createAirBroker(configFromEnv(env), deps);
  return {
    async listDevices() {
      return callBroker(async () => asList(await broker().listDevices(), "devices"));
    },
    async listContacts(deviceId) {
      return callBroker(async () => asList(await broker().listContacts(deviceId), "contacts"));
    },
    async sendSms(input) {
      const result = await callBroker(() => broker().sendSms(input));
      console.log(
        JSON.stringify({
          event: "sms_submitted",
          deviceId: input.deviceId,
          reqId: result.reqId,
          receiptStatus: result.receipt.status ?? "unknown",
        }),
      );
      return {
        ok: result.receipt.status?.toLowerCase() === "success",
        req_id: result.reqId,
        receipt: receiptBody(result.receipt),
      };
    },
  };
}

function configFromEnv(env: Env): AirBrokerConfig {
  return {
    baseUrl: env.AIR_BROKER_URL,
    accessCode: env.AIR_BROKER_ACCESS_CODE,
    deviceId: env.AIR_BROKER_DEVICE_ID,
    deviceToken: env.AIR_BROKER_DEVICE_TOKEN,
  };
}

async function callBroker<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AirBrokerError) {
      console.error(
        JSON.stringify({
          event: "air_broker_error",
          path: "/mcp",
          code: error.code,
          status: error.status,
        }),
      );
      throw error;
    }
    console.error(
      JSON.stringify({
        event: "air_broker_error",
        path: "/mcp",
        code: "internal",
      }),
    );
    throw new Error("internal error");
  }
}

function asList(body: unknown, event: string): unknown[] {
  if (!Array.isArray(body)) {
    throw new AirBrokerError(
      "air-broker returned an unexpected payload",
      502,
      "upstream",
    );
  }
  console.log(JSON.stringify({ event, count: body.length }));
  return body;
}

function receiptBody(receipt: SmsReceipt): {
  status?: string;
  to?: string;
  message?: string;
  req_id?: string;
} {
  return {
    ...(receipt.status !== undefined ? { status: receipt.status } : {}),
    ...(receipt.to !== undefined ? { to: receipt.to } : {}),
    ...(receipt.message !== undefined ? { message: receipt.message } : {}),
    ...(receipt.req_id !== undefined ? { req_id: receipt.req_id } : {}),
  };
}
