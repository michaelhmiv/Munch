import { PROTECTED_COMMERCE_TERMS } from "../src/product-config.js";
import { collectToolInventory } from "./openai-tool-inventory.js";

const inventory = await collectToolInventory();
const errors: string[] = [];

if (inventory.length === 0) errors.push("No exposed MCP tools were discovered.");

for (const tool of inventory) {
    if (!tool.title) errors.push(`${tool.name}: missing literal title`);
    if (!tool.description) errors.push(`${tool.name}: missing literal description`);
    if (!tool.hasInputSchema) errors.push(`${tool.name}: missing inputSchema`);
    if (!tool.hasOutputSchema) errors.push(`${tool.name}: missing outputSchema`);
    if (tool.readOnlyHint === null)
        errors.push(`${tool.name}: missing readOnlyHint`);
    if (tool.openWorldHint === null)
        errors.push(`${tool.name}: missing openWorldHint`);
    if (tool.destructiveHint === null)
        errors.push(`${tool.name}: missing destructiveHint`);
    if (tool.idempotentHint === null)
        errors.push(`${tool.name}: missing idempotentHint`);

    const input = tool.inputExcerpt.toLowerCase();
    if (/\buser_id\b/.test(input)) {
        errors.push(`${tool.name}: inputSchema must not accept user_id`);
    }
    if (
        /\b(password|otp|one_time_code|api_key|secret|access_token|refresh_token|credit_card|ssn)\b/.test(
            input,
        )
    ) {
        errors.push(`${tool.name}: inputSchema appears to solicit credentials`);
    }

    const description = tool.description?.toLowerCase() ?? "";
    for (const term of PROTECTED_COMMERCE_TERMS) {
        if (description.includes(term)) {
            errors.push(`${tool.name}: description contains ${term}`);
        }
    }
}

const submissionFile = Bun.file("chatgpt-app-submission.json");
if (!(await submissionFile.exists())) {
    errors.push("chatgpt-app-submission.json is missing");
} else {
    const submission = (await submissionFile.json()) as {
        app_info?: { subtitle?: string; category?: string };
        tools?: Record<
            string,
            {
                annotations?: Record<string, boolean | null>;
                justifications?: Record<string, string>;
            }
        >;
        test_cases?: unknown[];
        negative_test_cases?: unknown[];
    };
    if ((submission.app_info?.subtitle?.length ?? 31) > 30) {
        errors.push("Submission subtitle exceeds 30 characters");
    }
    if (submission.app_info?.category !== "FOOD") {
        errors.push("Submission category must be FOOD");
    }
    if (submission.test_cases?.length !== 5) {
        errors.push("Submission must contain exactly five positive test cases");
    }
    if (submission.negative_test_cases?.length !== 3) {
        errors.push("Submission must contain exactly three negative test cases");
    }

    const expectedNames = inventory.map((tool) => tool.name).sort();
    const submittedNames = Object.keys(submission.tools ?? {}).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(submittedNames)) {
        errors.push("Submission tool inventory does not match exposed MCP tools");
    }

    for (const name of submittedNames) {
        const submitted = submission.tools?.[name];
        for (const hint of [
            "readOnlyHint",
            "openWorldHint",
            "destructiveHint",
        ]) {
            if (typeof submitted?.annotations?.[hint] !== "boolean") {
                errors.push(`${name}: submission is missing ${hint}`);
            }
        }
        for (const justification of [
            "read_only_justification",
            "open_world_justification",
            "destructive_justification",
        ]) {
            if (!submitted?.justifications?.[justification]?.trim()) {
                errors.push(`${name}: submission is missing ${justification}`);
            }
        }
    }
}

if (errors.length > 0) {
    console.error("OpenAI submission audit failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(
    `OpenAI submission audit passed for ${inventory.length} exposed tools.`,
);
