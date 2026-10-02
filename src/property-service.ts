import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { clientFromEnvironment, InfraiError } from "./infrai-client.js";
import { buildTenantPlan, tenantProvisionSchema } from "./tenant-model.js";

const baseDomain = requiredEnvironment("PROPERTY_BASE_DOMAIN");
const cnameTarget = requiredEnvironment("PROPERTY_CNAME_TARGET");
const bucket = requiredEnvironment("TENANT_ASSET_BUCKET");
const port = Number(process.env.PORT ?? "3000");
const client = clientFromEnvironment();

type ProvisionedTenant = ReturnType<typeof buildTenantPlan>;
const tenants = new Map<string, ProvisionedTenant>();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) throw new RequestError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Request body must be valid JSON");
  }
}

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function provisionTenant(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = tenantProvisionSchema.parse(await readJson(request));
  const provisioningId = randomUUID();
  const domain = await client.getDomain(baseDomain);
  const plan = buildTenantPlan(input, baseDomain, new Date().toISOString().slice(0, 10));

  const record = await client.upsertTenantRecord({
    zoneId: domain.zone_id,
    hostname: plan.hostname,
    target: cnameTarget,
    provisioningId,
    tenantId: input.tenantId,
  });

  const documents = await Promise.all(plan.documents.map(async (document) => {
    const upload = await client.presignObject(bucket, document.objectKey, {
      op: "put",
      expires_seconds: 900,
      content_type: document.contentType,
      max_bytes: document.maxBytes,
      idempotency_key: `${provisioningId}:${document.objectKey}`,
    });
    return {
      key: document.key,
      objectKey: document.objectKey,
      tenantUrl: document.tenantUrl,
      uploadUrl: upload.url,
    };
  }));

  tenants.set(input.tenantId, plan);
  sendJson(response, 201, {
    tenantId: input.tenantId,
    hostname: plan.hostname,
    zoneId: domain.zone_id,
    recordId: record.record_id,
    documents,
    maintenance: plan.maintenance,
    inspections: plan.inspections,
  });
}

async function serveTenantAsset(
  request: IncomingMessage,
  response: ServerResponse,
  tenantId: string,
  documentKey: string,
): Promise<void> {
  const plan = tenants.get(tenantId);
  const expectedHost = plan?.hostname;
  if (!plan || request.headers.host?.split(":")[0] !== expectedHost) {
    throw new RequestError(404, "Tenant asset not found");
  }
  const document = plan.documents.find((candidate) => candidate.key === documentKey);
  if (!document) throw new RequestError(404, "Tenant asset not found");

  const download = await client.presignObject(bucket, document.objectKey, {
    op: "get",
    expires_seconds: 300,
    response_disposition: `inline; filename="${document.key.split("/").at(-1)}"`,
  });
  response.writeHead(302, { location: download.url });
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "POST" && url.pathname === "/tenants") {
      await provisionTenant(request, response);
      return;
    }
    const assetMatch = /^\/assets\/(.+)$/.exec(url.pathname);
    if (request.method === "GET" && assetMatch) {
      const tenantId = request.headers.host?.split(".")[0] ?? "";
      await serveTenantAsset(request, response, tenantId, decodeURIComponent(assetMatch[1]));
      return;
    }
    sendJson(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ZodError) {
      sendJson(response, 400, { error: "Invalid tenant payload", issues: error.issues });
    } else if (error instanceof RequestError) {
      sendJson(response, error.status, { error: error.message });
    } else if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      sendJson(response, status, { error: error.message, code: error.code });
    } else {
      console.error(error);
      sendJson(response, 500, { error: "Unexpected service error" });
    }
  }
});

server.listen(port, () => {
  console.log(`Property service listening on http://localhost:${port}`);
});
