import { z } from "zod";

/** Viewpoints used to branch the whys in several directions at every level. */
export const VIEWPOINTS = ["仕組み・道具", "人・体制", "手順・プロセス", "検知", "前提・外部"] as const;
export const ViewpointSchema = z.enum(VIEWPOINTS);
export type Viewpoint = z.infer<typeof ViewpointSchema>;

export const NODE_STATES = ["candidate", "digging", "leaf", "rejected", "hypothesis"] as const;
export const NodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof NodeStateSchema>;

export const EvidenceKindSchema = z.enum(["log", "code", "git", "metric", "doc", "other"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  ref: z.string(),
  summary: z.string(),
  supports: z.boolean(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FIELDS = ["supported", "sufficient", "likelihood", "impact", "preventable"] as const;
export const FieldSchema = z.enum(FIELDS);
export type Field = z.infer<typeof FieldSchema>;

export const SourceSchema = z.enum(["clef", "agent"]);
export type Source = z.infer<typeof SourceSchema>;

export const FieldValueSchema = z.object({
  value: z.number().min(0).max(1),
  source: SourceSchema,
  lowConfidence: z.boolean(),
  at: z.string(),
});
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const EvaluationSchema = z.object({
  fields: z.object({
    supported: FieldValueSchema.optional(),
    sufficient: FieldValueSchema.optional(),
    likelihood: FieldValueSchema.optional(),
    impact: FieldValueSchema.optional(),
    preventable: FieldValueSchema.optional(),
  }),
  stale: z.boolean(),
  history: z.array(FieldValueSchema.extend({ field: FieldSchema })),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const WhyNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  text: z.string(),
  viewpoint: ViewpointSchema.nullable(),
  state: NodeStateSchema,
  evidence: z.array(EvidenceSchema),
  evaluation: EvaluationSchema.nullable(),
  reason: z.string().optional(),
  countermeasure: z.string().optional(),
});
export type WhyNode = z.infer<typeof WhyNodeSchema>;

export const ANALYSIS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const AnalysisSchema = z.object({
  id: z.string().regex(ANALYSIS_ID),
  title: z.string(),
  problem: z.string(),
  status: z.enum(["open", "closed"]),
  nodes: z.array(WhyNodeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export type WhyErrorCode = "not_found" | "invalid_state" | "duplicate" | "conflict" | "invalid_input";

/** A refused operation. The MCP layer turns it into an error result `<code>: <message>`. */
export class WhyError extends Error {
  readonly code: WhyErrorCode;
  constructor(code: WhyErrorCode, message: string) {
    super(message);
    this.name = "WhyError";
    this.code = code;
  }
}
