import { clientFromEnvironment } from "./infrai-client.js";

const bucket = process.env.TENANT_ASSET_BUCKET;
if (!bucket) throw new Error("TENANT_ASSET_BUCKET is required");

const client = clientFromEnvironment();
const created = await client.createBucket(bucket);
console.log(JSON.stringify({ ok: true, bucket: created.name ?? bucket }, null, 2));
