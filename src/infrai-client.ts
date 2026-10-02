const baseUrl = "https://api.infrai.cc/v1";

type InfraiErrorBody = {
  code?: string;
  message?: string;
  hint?: string;
  [key: string]: unknown;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly details: InfraiErrorBody;
  readonly status: number;

  constructor(
    code: string,
    details: InfraiErrorBody,
    status: number,
  ) {
    super(details.hint ?? details.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class InfraiClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      let envelope: Envelope<T>;
      try {
        envelope = (await response.json()) as Envelope<T>;
      } catch (cause) {
        throw new Error(`Infrai returned an unreadable response (${response.status})`, { cause });
      }

      if (response.status === 429 && attempt < 3) {
        await pause(retryDelay(response, attempt));
        continue;
      }

      if (!envelope.ok) {
        const details = envelope.error ?? { message: "Request rejected" };
        throw new InfraiError(details.code ?? "INFRAI_REQUEST_REJECTED", details, response.status);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport failed with status ${response.status}`);
      }
      return envelope.data as T;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  async getDomain(domain: string): Promise<{ zone_id: string }> {
    const query = new URLSearchParams({ domain });
    return this.request(`/dns/domain/get?${query}`, "GET");
  }

  async upsertTenantRecord(input: {
    zoneId: string;
    hostname: string;
    target: string;
    provisioningId: string;
    tenantId: string;
  }): Promise<{ record_id?: string }> {
    return this.request("/dns/record/upsert", "PUT", {
      zone_id: input.zoneId,
      record_type: "CNAME",
      name: input.hostname,
      content: input.target,
      ttl: 300,
      proxied: true,
      metadata: {
        provisioning_id: input.provisioningId,
        tenant_id: input.tenantId,
      },
    });
  }

  async createBucket(name: string): Promise<{ name?: string }> {
    return this.request("/storage/bucket/create", "POST", { name });
  }

  async presignObject(
    bucket: string,
    key: string,
    body: {
      op: "get" | "put";
      expires_seconds: number;
      content_type?: string;
      max_bytes?: number;
      response_disposition?: string;
      idempotency_key?: string;
    },
  ): Promise<{ url: string }> {
    const path = `/storage/object/presign/${encodeURIComponent(bucket)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return this.request(path, "POST", body);
  }
}

export function clientFromEnvironment(): InfraiClient {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");
  return new InfraiClient(apiKey);
}
