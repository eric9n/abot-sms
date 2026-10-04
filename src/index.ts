import {
  AirBrokerError,
  createAirBroker,
  type AirBrokerConfig,
} from "./air-broker.js";

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PHONE_NUMBER = /^\+?[0-9]{3,20}$/;
const MAX_BODY_CHARS = 8_192;
const MAX_SMS_CHARS = 1_600;

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

  try {
    if (request.method === "GET" && path === "/devices") {
      const devices = await createAirBroker(configFromEnv(env), deps).listDevices();
      return jsonList(devices, "devices");
    }

    if (request.method === "GET" && path === "/contacts") {
      const device = url.searchParams.get("device") ?? "";
      return listContacts(env, device, deps);
    }

    if (request.method === "GET" && path.startsWith("/contacts/")) {
      const device = deviceFromPath(path);
      if (device === undefined) {
        return errorJson(400, "device is required");
      }
      return listContacts(env, device, deps);
    }

    if (request.method === "POST" && path === "/sms") {
      return sendSms(request, env, deps);
    }
  } catch (error) {
    return errorResponse(error, path);
  }

  return errorJson(404, "not found");
}

function configFromEnv(env: Env): AirBrokerConfig {
  return {
    baseUrl: env.AIR_BROKER_URL,
    accessCode: env.AIR_BROKER_ACCESS_CODE,
    deviceId: env.AIR_BROKER_DEVICE_ID,
    deviceToken: env.AIR_BROKER_DEVICE_TOKEN,
  };
}

async function listContacts(
  env: Env,
  device: string,
  deps: Parameters<typeof createAirBroker>[1],
): Promise<Response> {
  const deviceId = validDeviceId(device);
  if (!deviceId) return errorJson(400, "device is required");
  const contacts = await createAirBroker(configFromEnv(env), deps).listContacts(deviceId);
  return jsonList(contacts, "contacts");
}

async function sendSms(
  request: Request,
  env: Env,
  deps: Parameters<typeof createAirBroker>[1],
): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const deviceId = validDeviceId(body.deviceId);
  const to = validPhoneNumber(body.to);
  const content = validText(body.content, MAX_SMS_CHARS);
  if (!deviceId || !to || !content) {
    return errorJson(400, "deviceId, to (digits, optional leading +), and content are required");
  }

  const result = await createAirBroker(configFromEnv(env), deps).sendSms({
    deviceId,
    to,
    content,
  });
  console.log(
    JSON.stringify({
      event: "sms_submitted",
      deviceId,
      reqId: result.reqId,
      receiptStatus: result.receipt.status ?? "unknown",
    }),
  );
  return Response.json({
    ok: result.receipt.status?.toLowerCase() === "success",
    req_id: result.reqId,
    receipt: result.receipt,
  });
}

function jsonList(body: unknown, event: string): Response {
  if (!Array.isArray(body)) {
    throw new AirBrokerError(
      "air-broker returned an unexpected payload",
      502,
      "upstream",
    );
  }
  console.log(JSON.stringify({ event, count: body.length }));
  return Response.json(body);
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS * 4) return errorJson(413, "body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return errorJson(413, "body too large");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorJson(400, "JSON object required");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorJson(400, "JSON object required");
  }
}

function deviceFromPath(pathname: string): string | undefined {
  const rest = pathname.slice("/contacts/".length);
  if (!rest || rest.includes("/")) return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

function validDeviceId(value: unknown): string | undefined {
  const text = validText(value, 128);
  if (!text || !DEVICE_ID.test(text)) return undefined;
  return text;
}

function validPhoneNumber(value: unknown): string | undefined {
  const text = validText(value, 32)?.replace(/[\s-]/g, "");
  if (!text || !PHONE_NUMBER.test(text)) return undefined;
  return text;
}

function validText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function errorResponse(error: unknown, path: string): Response {
  if (error instanceof AirBrokerError) {
    console.error(
      JSON.stringify({
        event: "air_broker_error",
        path,
        code: error.code,
        status: error.status,
      }),
    );
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return errorJson(status, error.message);
  }
  console.error(
    JSON.stringify({
      event: "air_broker_error",
      path,
      code: "internal",
    }),
  );
  return errorJson(500, "internal error");
}

function errorJson(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
