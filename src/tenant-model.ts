import { z } from "zod";

const slug = z.string().min(2).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const tenantProvisionSchema = z.object({
  tenantId: slug,
  tenantName: z.string().min(2).max(120),
  maintenanceRequests: z.array(z.object({
    summary: z.string().min(3).max(300),
    priority: z.enum(["routine", "urgent"]),
    reportedBy: z.string().min(2).max(120),
  })).max(50),
  documents: z.array(z.object({
    key: z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
    contentType: z.string().min(3).max(120),
    maxBytes: z.number().int().positive().max(25_000_000),
  })).max(20).refine(
    (documents) => new Set(documents.map((document) => document.key)).size === documents.length,
    "Document keys must be unique within a tenant",
  ),
  inspectionReminders: z.array(z.object({
    propertyRef: z.string().min(1).max(80),
    dueOn: z.string().date(),
  })).max(100),
});

export type TenantProvisionInput = z.infer<typeof tenantProvisionSchema>;

export function buildTenantPlan(
  input: TenantProvisionInput,
  baseDomain: string,
  today: string,
) {
  const hostname = `${input.tenantId}.${baseDomain}`;
  return {
    hostname,
    documents: input.documents.map((document) => ({
      ...document,
      objectKey: `tenants/${input.tenantId}/${document.key}`,
      tenantUrl: `https://${hostname}/assets/${encodeURIComponent(document.key)}`,
    })),
    maintenance: {
      open: input.maintenanceRequests.length,
      urgent: input.maintenanceRequests.filter((request) => request.priority === "urgent").length,
    },
    inspections: input.inspectionReminders.map((reminder) => ({
      ...reminder,
      status: reminder.dueOn <= today ? "due" as const : "scheduled" as const,
    })),
  };
}
