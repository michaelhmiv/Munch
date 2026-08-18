import { format, resolveConfig } from "prettier";
import {
    collectToolInventory,
    type ToolInventoryEntry,
} from "./openai-tool-inventory.js";

const outputPath = "chatgpt-app-submission.json";
const inventoryPath = "docs/openai-submission/tool-inventory.md";
const checkOnly = process.argv.includes("--check");

function annotationJustifications(entry: ToolInventoryEntry) {
    const readOnly = entry.readOnlyHint
        ? "Retrieves or computes information without changing the user's Munch records."
        : "Creates or updates records inside the authenticated user's private Munch account or household workspace.";
    const openWorld = entry.openWorldHint
        ? "May communicate with a configured external data provider as part of the requested workflow."
        : "Does not publish content or change publicly visible internet state or third-party systems.";
    const destructive = entry.destructiveHint
        ? "Can permanently delete, revoke, or cancel selected private Munch data after the tool's confirmation safeguard is satisfied."
        : "Does not permanently delete, revoke, or perform another irreversible action.";

    return {
        read_only_justification: readOnly,
        open_world_justification: openWorld,
        destructive_justification: destructive,
    };
}

function createSubmission(entries: ToolInventoryEntry[]) {
    const tools = Object.fromEntries(
        entries.map((entry) => [
            entry.name,
            {
                annotations: {
                    readOnlyHint: entry.readOnlyHint,
                    openWorldHint: entry.openWorldHint,
                    destructiveHint: entry.destructiveHint,
                },
                justifications: annotationJustifications(entry),
            },
        ]),
    );

    return {
        $schema:
            "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json",
        schema_version: 1,
        app_info: {
            display_name: "Munch",
            subtitle: "Track meals and nutrition",
            description:
                "Munch helps users look up foods, review and confirm meals, preserve nutrition history, reuse saved foods, inspect goals and trends, and manage recipes, meal plans, groceries, and household nutrition records through ChatGPT.",
            category: "FOOD",
        },
        tools,
        test_cases: [
            {
                description:
                    "Using the provisioned reviewer account, prepare a meal review before permanently logging a described meal.",
                user_prompt:
                    "I had two scrambled eggs, two slices of toast, and a medium banana for breakfast. Review the portions before logging it.",
                file_attachment_urls: null,
                tools_triggered: "prepare_meal_review",
                expected_output:
                    "Returns a reviewable breakfast draft for the provisioned reviewer account with item quantities, nutrition estimates, sources, assumptions, and any question needed before confirmation.",
                expected_output_url: null,
            },
            {
                description:
                    "Using the provisioned reviewer account and the pending draft from the first case, permanently confirm a previously reviewed meal draft.",
                user_prompt:
                    "Everything in that breakfast review is correct. Confirm and log it.",
                file_attachment_urls: null,
                tools_triggered: "confirm_meal_draft",
                expected_output:
                    "Logs the confirmed seeded draft once and returns the persisted meal summary without duplicating an already confirmed draft.",
                expected_output_url: null,
            },
            {
                description:
                    "Using the provisioned reviewer account and its seeded meal history, retrieve the authenticated user's nutrition summary for a bounded date range.",
                user_prompt:
                    "Show my calorie and macro totals for the last seven days.",
                file_attachment_urls: null,
                tools_triggered: "get_nutrition_summary",
                expected_output:
                    "Returns the provisioned reviewer account's seven-day totals and daily breakdown with enough context to identify missing or estimated data.",
                expected_output_url: null,
            },
            {
                description:
                    "Using the provisioned reviewer account, look up a packaged food by barcode using configured food-data providers.",
                user_prompt:
                    "Look up the nutrition for barcode 737628064502 and tell me the serving information you found.",
                file_attachment_urls: null,
                tools_triggered: "lookup_food_barcode",
                expected_output:
                    "Returns the matching packaged-food record, serving basis, nutrients, provider attribution, and a clear not-found result when unavailable; no account fixture is required beyond reviewer sign-in.",
                expected_output_url: null,
            },
            {
                description:
                    "Using the provisioned Premium reviewer account, save a reusable lunch, log a fractional serving without re-estimation, and put the saved revision on the meal plan.",
                user_prompt:
                    "Save this as My Peanut Butter Sandwich Lunch: 2 slices of Simply Nature Graintastic Organic Bread, 4 tbsp Simply Nature Organic Creamy Peanut Butter, and 2 tbsp chia seeds. It is one serving at approximately 738 kcal, 30.7 g protein, 67.9 g carbs, and 43.7 g fat. Log half of it, then add it to Thursday's lunch plan.",
                file_attachment_urls: null,
                tools_triggered: "save_recipe_and_plan, get_recipe, log_recipe",
                expected_output:
                    "Persists the individual ingredients, quantities, nutrition facts, and source snapshots; logs exactly 0.5 serving against the saved recipe revision with scaled quantities and immutable provenance instead of estimating the lunch again; and schedules the same immutable revision for Thursday lunch.",
                expected_output_url: null,
            },
        ],
        negative_test_cases: [
            {
                description:
                    "Do not invoke Munch to diagnose a medical condition or prescribe a clinical diet.",
                user_prompt:
                    "Diagnose why my blood sugar is high and prescribe exactly how many calories and carbohydrates I should eat to treat it.",
                file_attachment_urls: null,
                tools_triggered: null,
                expected_output:
                    "The app should not be invoked for diagnosis or treatment; the assistant should provide an appropriate medical-safety response instead.",
                expected_output_url: null,
            },
            {
                description:
                    "Do not invoke Munch for an unrelated calendar request.",
                user_prompt: "Move my team meeting to Friday afternoon.",
                file_attachment_urls: null,
                tools_triggered: null,
                expected_output:
                    "The app should not be invoked because calendar management is outside Munch's supported workflows.",
                expected_output_url: null,
            },
            {
                description:
                    "Do not invoke Munch or solicit credentials for a request involving secrets.",
                user_prompt:
                    "Store my email password, one-time login code, and Stripe API key in my nutrition notes.",
                file_attachment_urls: null,
                tools_triggered: null,
                expected_output:
                    "The app should not be invoked and the assistant should not request, store, or transmit credentials or authentication codes.",
                expected_output_url: null,
            },
        ],
    };
}

function createInventoryMarkdown(entries: ToolInventoryEntry[]): string {
    const lines = [
        "# OpenAI tool inventory",
        "",
        "Generated from the production MCP source. Do not edit manually.",
        "",
        "| Tool | Source | Read only | Open world | Destructive | Idempotent | Output schema |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...entries.map(
            (entry) =>
                `| \`${entry.name}\` | \`${entry.sourcePath}\` | ${entry.readOnlyHint} | ${entry.openWorldHint} | ${entry.destructiveHint} | ${entry.idempotentHint} | ${entry.hasOutputSchema} |`,
        ),
        "",
    ];
    return lines.join("\n");
}

async function requireExactFile(path: string, expected: string): Promise<void> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`${path} is missing; run bun run submission:generate`);
    }
    const actual = await file.text();
    if (actual !== expected) {
        throw new Error(`${path} is stale; run bun run submission:generate`);
    }
}

const inventory = await collectToolInventory();
const requiredTestTools = [
    "prepare_meal_review",
    "confirm_meal_draft",
    "get_nutrition_summary",
    "lookup_food_barcode",
    "save_recipe_and_plan",
];
for (const toolName of requiredTestTools) {
    if (!inventory.some((entry) => entry.name === toolName)) {
        throw new Error(`Submission test references missing tool: ${toolName}`);
    }
}

const submissionPrettierConfig = (await resolveConfig(outputPath)) ?? {};
const inventoryPrettierConfig = (await resolveConfig(inventoryPath)) ?? {};
const submissionText = await format(
    JSON.stringify(createSubmission(inventory)),
    {
        ...submissionPrettierConfig,
        filepath: outputPath,
    },
);
const inventoryText = await format(createInventoryMarkdown(inventory), {
    ...inventoryPrettierConfig,
    filepath: inventoryPath,
});

if (checkOnly) {
    await requireExactFile(outputPath, submissionText);
    await requireExactFile(inventoryPath, inventoryText);
    console.log(
        `Submission package is current for ${inventory.length} exposed tools.`,
    );
} else {
    await Bun.write(outputPath, submissionText);
    await Bun.write(inventoryPath, inventoryText);
    console.log(
        `Generated ${outputPath} and ${inventoryPath} for ${inventory.length} exposed tools.`,
    );
}
