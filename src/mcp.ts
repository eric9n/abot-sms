/**
 * Stateless MCP (JSON-RPC) endpoint.
 * Tool names are unprefixed so a gateway can advertise them as sms_<name>.
 */

import { AirBrokerError } from "./air-broker.js";

const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PHONE_NUMBER = /^\+?[0-9]{3,20}$/;
const MAX_BODY_CHARS = 8_192;
const MAX_SMS_CHARS = 1_600;
const MAX_NUMBER_CHARS = 32;

const deviceIdSchema = {
  type: "string",
  description: "Air-broker device id.",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]{1,128}$",
} as const;

export const TOOLS = [
  {
    name: "list_devices",
    title: "List devices",
    description: "List SMS devices known to the air-broker, including id and online status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        devices: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["devices"],
      additionalProperties: false,
    },
  },
  {
    name: "list_contacts",
    title: "List contacts",
    description: "List contacts stored on one SMS device.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdSchema,
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        contacts: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["contacts"],
      additionalProperties: false,
    },
  },
  {
    name: "send_sms",
    title: "Send SMS",
    description:
      "Send an SMS from a device. deviceId is the sending device, to is the destination number, and content is the message text.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdSchema,
        to: {
          type: "string",
          description: "Destination phone number: digits with an optional leading +. Spaces and dashes are ignored.",
          minLength: 1,
          maxLength: MAX_NUMBER_CHARS,
        },
        content: {
          type: "string",
          description: "Message text.",
          minLength: 1,
          maxLength: MAX_SMS_CHARS,
        },
      },
      required: ["deviceId", "to", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        req_id: { type: "string" },
        receipt: {
          type: "object",
          properties: {
            status: { type: "string" },
            to: { type: "string" },
            message: { type: "string" },
            req_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["ok", "req_id", "receipt"],
      additionalProperties: false,
    },
  },
] as const;

export interface SmsReceiptBody {
  status?: string;
  to?: string;
  message?: string;
  req_id?: string;
}

export interface SmsTools {
  listDevices(): Promise<unknown[]>;
  listContacts(deviceId: string): Promise<unknown[]>;
  sendSms(input: {
    deviceId: string;
    to: string;
    content: string;
  }): Promise<{ ok: boolean; req_id: string; receipt: SmsReceiptBody }>;
}

type JsonRpcId = string | number | null;

export async function handleMcp(
  request: Request,
  tools: SmsTools,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS * 4) {
    return rpcError(null, INVALID_REQUEST, "body too large", 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return rpcError(null, INVALID_REQUEST, "body too large", 413);
  }
  if (!text.trim()) {
    return rpcError(null, PARSE_ERROR, "parse error", 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rpcError(null, PARSE_ERROR, "parse error", 400);
  }
  if (Array.isArray(parsed)) {
    return rpcError(null, INVALID_REQUEST, "JSON-RPC batching is not supported", 400);
  }
  if (!isRecord(parsed)) {
    return rpcError(null, INVALID_REQUEST, "invalid request", 400);
  }
  if (parsed.jsonrpc !== "2.0") {
    return rpcError(readId(parsed.id) ?? null, INVALID_REQUEST, "invalid request");
  }

  const method = parsed.method;
  if (typeof method !== "string" || !method) {
    return rpcError(readId(parsed.id) ?? null, INVALID_REQUEST, "invalid request");
  }

  const id = readId(parsed.id);
  if (parsed.id !== undefined && id === undefined) {
    return rpcError(null, INVALID_REQUEST, "invalid request");
  }
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  if (parsed.params !== undefined && !isRecord(parsed.params)) {
    return rpcError(id, INVALID_PARAMS, "invalid params");
  }
  const params = isRecord(parsed.params) ? parsed.params : {};

  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, initializeResult(params));
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, listTools(params));
      case "tools/call":
        return rpcResult(id, await callTool(params, tools));
      default:
        return rpcError(id, METHOD_NOT_FOUND, "method not found");
    }
  } catch (error) {
    if (error instanceof ParamsError) {
      return rpcError(id, INVALID_PARAMS, error.message);
    }
    const message =
      error instanceof AirBrokerError
        ? error.message
        : "internal error";
    return rpcResult(id, toolError(message));
  }
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: negotiateVersion(params.protocolVersion),
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "abot-sms",
      version: "1.0.0",
    },
    instructions:
      "List devices, list the contacts on a device, and send an SMS. send_sms needs deviceId, to, and content. A receipt status of fail means the message was published and the device or the live worker rejected it.",
  };
}

function negotiateVersion(clientVersion: unknown): string {
  if (
    typeof clientVersion === "string" &&
    (PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
  ) {
    return clientVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

function listTools(params: Record<string, unknown>): { tools: typeof TOOLS } {
  if (params.cursor !== undefined) {
    throw new ParamsError("invalid cursor");
  }
  return { tools: TOOLS };
}

async function callTool(
  params: Record<string, unknown>,
  tools: SmsTools,
): Promise<Record<string, unknown>> {
  const name = params.name;
  if (typeof name !== "string" || !name) {
    throw new ParamsError("tool name is required");
  }
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    throw new ParamsError("arguments must be an object");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};

  switch (name) {
    case "list_devices": {
      rejectUnknown(args, []);
      const devices = await tools.listDevices();
      return toolOk({ devices });
    }
    case "list_contacts": {
      rejectUnknown(args, ["deviceId"]);
      const deviceId = validDeviceId(args.deviceId);
      if (!deviceId) throw new ParamsError("deviceId is required");
      const contacts = await tools.listContacts(deviceId);
      return toolOk({ contacts });
    }
    case "send_sms": {
      rejectUnknown(args, ["deviceId", "to", "content"]);
      const deviceId = validDeviceId(args.deviceId);
      const to = validPhoneNumber(args.to);
      const content = validText(args.content, MAX_SMS_CHARS);
      if (!deviceId || !to || !content) {
        throw new ParamsError("deviceId, to, and content are required");
      }
      return toolOk(await tools.sendSms({ deviceId, to, content }));
    }
    default:
      throw new ParamsError(`unknown tool ${JSON.stringify(name)}`);
  }
}

function toolOk(structured: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

function rejectUnknown(args: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ParamsError(`unexpected argument ${JSON.stringify(key)}`);
    }
  }
}

function validDeviceId(value: unknown): string | undefined {
  const text = validText(value, 128);
  if (!text || !DEVICE_ID.test(text)) return undefined;
  return text;
}

function validPhoneNumber(value: unknown): string | undefined {
  const text = validText(value, MAX_NUMBER_CHARS)?.replace(/[\s-]/g, "");
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

function readId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function rpcResult(id: JsonRpcId, result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
