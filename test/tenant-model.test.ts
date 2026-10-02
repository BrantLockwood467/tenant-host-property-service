import assert from "node:assert/strict";
import test from "node:test";
import { buildTenantPlan, tenantProvisionSchema } from "../src/tenant-model.js";

const common = {
  tenantName: "North Arcade Management",
  maintenanceRequests: [
    { summary: "Replace the loading-bay light", priority: "urgent" as const, reportedBy: "Mina" },
    { summary: "Touch up suite 204 paint", priority: "routine" as const, reportedBy: "Owen" },
  ],
  documents: [
    { key: "leases/unit-204.pdf", contentType: "application/pdf", maxBytes: 2_000_000 },
  ],
  inspectionReminders: [
    { propertyRef: "unit-204", dueOn: "2026-10-01" },
    { propertyRef: "loading-bay", dueOn: "2026-10-08" },
  ],
};

test("tenant plans isolate documents and mark inspections due on the business date", () => {
  const north = tenantProvisionSchema.parse({ tenantId: "north-arcade", ...common });
  const south = tenantProvisionSchema.parse({ tenantId: "south-arcade", ...common });
  const northPlan = buildTenantPlan(north, "manage.example.com", "2026-10-01");
  const southPlan = buildTenantPlan(south, "manage.example.com", "2026-10-01");

  assert.equal(northPlan.hostname, "north-arcade.manage.example.com");
  assert.notEqual(northPlan.documents[0].objectKey, southPlan.documents[0].objectKey);
  assert.deepEqual(northPlan.inspections.map((item) => item.status), ["due", "scheduled"]);
  assert.deepEqual(northPlan.maintenance, { open: 2, urgent: 1 });
});
