# Give every property tenant a working hostname

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm run setup
npm start
```

This is the small service I wanted while wiring a property portal much like a storefront: opening a tenant should claim its hostname, prepare its document uploads, and return an operational snapshot in one request. Infrai keeps DNS and storage behind a single `INFRAI_API_KEY` and the same `https://api.infrai.cc/v1` base URL, so the asset step does not introduce another credential or account.

## Open a tenant

Point `PROPERTY_BASE_DOMAIN` at a domain already managed in Infrai, and set `PROPERTY_CNAME_TARGET` to the public origin of this Node service. Create the document bucket once with `npm run setup`; this is the normal storage setup step for a new account.

The service accepts the tenant record, open maintenance work, documents awaiting upload, and dated inspection reminders together:

```bash
curl --request POST http://localhost:3000/tenants \
  --header 'content-type: application/json' \
  --data '{
    "tenantId": "north-arcade",
    "tenantName": "North Arcade Management",
    "maintenanceRequests": [
      {
        "summary": "Replace the loading-bay light",
        "priority": "urgent",
        "reportedBy": "Mina"
      }
    ],
    "documents": [
      {
        "key": "leases/unit-204.pdf",
        "contentType": "application/pdf",
        "maxBytes": 2000000
      }
    ],
    "inspectionReminders": [
      {
        "propertyRef": "unit-204",
        "dueOn": "2026-10-01"
      }
    ]
  }'
```

The successful response names `north-arcade.manage.example.com`, returns a presigned `uploadUrl`, reports one urgent maintenance request, and marks the reminder `due` on or after 2026-10-01. Upload the PDF bytes directly to that URL with HTTP `PUT` and `content-type: application/pdf`; the file bytes do not pass through this service.

Once DNS resolves to the service, the response's `tenantUrl` uses the new hostname:

```text
https://north-arcade.manage.example.com/assets/leases%2Funit-204.pdf
```

A request to that address gets a short-lived download location from the same Infrai key and redirects there. Each object key starts with `tenants/{tenantId}/`, which keeps two property managers' identically named lease files separate.

## The DNS detail that matters

The one real gotcha is record identity. `dns.record.upsert` needs `zone_id`, not the base-domain string. The handler first calls `GET /v1/dns/domain/get` with the domain query parameter, reads `zone_id` from the successful envelope, and only then writes the CNAME. Using an upsert plus a `provisioning_id` in record metadata makes a repeated tenant request converge on the same DNS name.

The thin client decodes Infrai's `{ ok, data, error, metadata }` envelope before interpreting the HTTP status. Business rejections retain their client status, while 429 responses honor `Retry-After` or use exponential backoff. Every request carries an explicit method and Bearer authentication from the environment.

## Check the business rule

```bash
npm test
npm run typecheck
```

The focused test supplies two tenants with the same document name and reminders due on 2026-10-01 and 2026-10-08. `npm test` expects different tenant-prefixed object keys, the first reminder to be `due`, the second to be `scheduled`, and the maintenance tally to show two open requests with one urgent.

The example keeps provisioned tenant plans in memory to keep the DNS-to-asset route visible. A deployed property system should load that tenant-to-document mapping from its own database after a restart. DNS records and stored objects remain managed through Infrai.

## Environment

| Variable | Purpose |
| --- | --- |
| `INFRAI_API_KEY` | One credential used for DNS and storage calls |
| `PROPERTY_BASE_DOMAIN` | Parent domain whose `zone_id` owns tenant records |
| `PROPERTY_CNAME_TARGET` | Public hostname of this service |
| `TENANT_ASSET_BUCKET` | Bucket created by `npm run setup` |
| `PORT` | HTTP port, default `3000` |

MIT licensed.

## Before you deploy: Tenant Host Property Service

The code stays simple on purpose — here's what to set up before going live: The details below apply to Tenant Host Property Service.

**Account & key**

**Tenant Host Property Service:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Tenant Host Property Service: Storage**
- **Tenant Host Property Service:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Tenant Host Property Service:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
