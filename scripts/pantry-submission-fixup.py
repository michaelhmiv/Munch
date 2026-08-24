from pathlib import Path

# reconcile_pantry can consume, discard, or deplete inventory, so the MCP
# contract requires an explicit schema-enforced confirmation field. The model
# may set it only when the user's current instruction explicitly authorizes the
# destructive Pantry change.
tools = Path("src/inventory/tools.ts")
text = tools.read_text()
old_description = '''            description:
                "Apply a batch Pantry update only from explicit user facts: what they bought, used, finished, discarded, moved, or corrected. Never infer meal consumption and silently subtract it. It is fine to propose likely matches first with get_pantry, then reconcile only after the user clarifies.",'''
new_description = '''            description:
                "Apply a batch Pantry update only from explicit user facts: what they bought, used, finished, discarded, moved, or corrected. Never infer meal consumption and silently subtract it. It is fine to propose likely matches first with get_pantry, then reconcile only after the user clarifies. Because this tool can consume, discard, or deplete inventory, set confirmation=true only when the user's current instruction explicitly authorizes the Pantry changes being applied.",'''
if old_description in text:
    text = text.replace(old_description, new_description, 1)
elif "set confirmation=true only when" not in text:
    raise SystemExit("reconcile_pantry description marker missing")

old_schema = '''                idempotency_key: z.string().min(1).max(255),
                operations: z.array(operationSchema).min(1).max(100),'''
new_schema = '''                idempotency_key: z.string().min(1).max(255),
                confirmation: z
                    .literal(true)
                    .describe(
                        "Required. Set true only after the user's current instruction explicitly confirms the Pantry changes in this batch, including any consumption, discard, or depletion.",
                    ),
                operations: z.array(operationSchema).min(1).max(100),'''
if old_schema in text:
    text = text.replace(old_schema, new_schema, 1)
elif ".literal(true)" not in text or "explicitly confirms the Pantry changes" not in text:
    raise SystemExit("reconcile_pantry confirmation schema marker missing")
tools.write_text(text)

# Keep the marketplace description current with the optional Premium surface.
generator = Path("scripts/generate-openai-submission.ts")
text = generator.read_text()
old_app_description = '''                "Munch helps users look up foods, review and confirm meals, preserve nutrition history, reuse saved foods, inspect goals and trends, and manage recipes, meal plans, groceries, and household nutrition records through ChatGPT.",'''
new_app_description = '''                "Munch helps users look up foods, review and confirm meals, preserve nutrition history, reuse saved foods, inspect goals and trends, and manage recipes, meal plans, groceries, optional Premium Pantry inventory, and household nutrition records through ChatGPT.",'''
if old_app_description in text:
    text = text.replace(old_app_description, new_app_description, 1)
elif "optional Premium Pantry inventory" not in text:
    raise SystemExit("submission app description marker missing")
generator.write_text(text)
