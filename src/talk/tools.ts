import { Type, type FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { NODE_STATES, VIEWPOINTS, ViewpointSchema, NodeStateSchema } from "../model.ts";

/** What Gemini may call during the talk. The server applies each call to the session's tree. */
export const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "add_whys",
    description: "Add one or more candidate reasons (whys) under a node of the tree. Use whenever the person gives a new reason, or when you branch with 'what else?'. The root n0 is the topic.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        parent_id: { type: Type.STRING, description: "Id of the node these reasons explain, e.g. n0." },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: "The reason in one short Japanese sentence, in the person's words." },
              viewpoint: { type: Type.STRING, enum: [...VIEWPOINTS] },
            },
            required: ["text", "viewpoint"],
          },
        },
      },
      required: ["parent_id", "items"],
    },
  },
  {
    name: "add_fact",
    description: "Record a fact the person stated that supports or argues against a node.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        node_id: { type: Type.STRING },
        summary: { type: Type.STRING, description: "The fact in one Japanese sentence." },
        supports: { type: Type.BOOLEAN, description: "true if it supports the reason, false if it argues against it." },
      },
      required: ["node_id", "summary", "supports"],
    },
  },
  {
    name: "update_branch",
    description: "Change a branch: digging (we are exploring it), leaf (a mechanism change would prevent it; needs countermeasure, and a reason too when the node is fewer than 5 whys deep), hypothesis (cannot be confirmed; needs reason), rejected (ruled out; needs reason), candidate (reopen; needs reason when coming back from rejected or hypothesis).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        node_id: { type: Type.STRING },
        state: { type: Type.STRING, enum: [...NODE_STATES] },
        reason: { type: Type.STRING },
        countermeasure: { type: Type.STRING },
      },
      required: ["node_id", "state"],
    },
  },
  {
    name: "propose_direction",
    description: "When the person asks to wrap up, draft the final direction. All fields in Japanese.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING, description: "The direction decided in the talk." },
        reasons: { type: Type.STRING, description: "Why, in a few sentences, citing the tree." },
        rejected: { type: Type.STRING, description: "Alternatives considered and set aside, with why." },
        open_questions: { type: Type.STRING, description: "What is still unclear or needs checking." },
      },
      required: ["direction", "reasons", "rejected", "open_questions"],
    },
  },
];

export const ToolArgs = {
  add_whys: z.object({
    parent_id: z.string(),
    items: z.array(z.object({ text: z.string().min(1), viewpoint: ViewpointSchema })).min(1).max(10),
  }),
  add_fact: z.object({ node_id: z.string(), summary: z.string().min(1), supports: z.boolean() }),
  update_branch: z.object({
    node_id: z.string(),
    state: NodeStateSchema,
    reason: z.string().optional(),
    countermeasure: z.string().optional(),
  }),
  propose_direction: z.object({
    direction: z.string(),
    reasons: z.string(),
    rejected: z.string(),
    open_questions: z.string(),
  }),
};

export type ToolName = keyof typeof ToolArgs;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(ToolArgs, name);
}
