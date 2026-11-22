import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Category, Policy } from "./model.js";
import type { ManagedInput } from "./store.js";

const quantity = (description: string) =>
  Type.Union(
    [
      Type.Number({ minimum: 1 }),
      Type.String({ minLength: 1, maxLength: 128 }),
    ],
    { description },
  );

const policySchema = Type.Object(
  {
    ttlHours: Type.Optional(
      quantity("Hours or a duration such as 24h, 30d or 7w."),
    ),
    maxItems: Type.Optional(
      quantity(
        "Whole item count, e.g. 16384 or 16k; k/m/g use binary multipliers.",
      ),
    ),
    maxBytes: Type.Optional(
      quantity("Bytes or a binary size, e.g. 2G or 1.5GiB."),
    ),
    purgeAfterHours: Type.Optional(
      quantity(
        "Minimum recovery window, numeric hours or a duration such as 7d.",
      ),
    ),
    maxRecycledBytes: Type.Optional(
      quantity("Recycled-byte budget, numeric bytes or a size such as 1G."),
    ),
  },
  { additionalProperties: false },
);

export function managedSchema(category: Category) {
  return Type.Object(
    {
      action: Type.String({
        enum: [
          "create",
          "list",
          "inspect",
          "restore",
          "release",
          "cleanup",
          "policy",
          "pin",
          "touch",
        ],
      }),
      path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Controller-local source path for backup; resolved against the local Pi cwd.",
        }),
      ),
      name: Type.Optional(Type.String({ minLength: 1 })),
      kind: Type.Optional(Type.String({ enum: ["file", "directory"] })),
      content: Type.Optional(Type.String()),
      purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      id: Type.Optional(Type.String({ minLength: 1 })),
      destination: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Controller-local restore destination; resolved against the local Pi cwd.",
        }),
      ),
      ttlHours: Type.Optional(
        quantity("Hours or a duration such as 24h, 30d or 7w."),
      ),
      pinned: Type.Optional(Type.Boolean()),
      execute: Type.Optional(Type.Boolean()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      policy: Type.Optional(policySchema),
    },
    { additionalProperties: false },
  );
}

export type ManagedToolResult = ReturnType<typeof managedSchema>;
export type { ManagedInput };
