#!/usr/bin/env bun

import {
    inventoryVisionConfig,
    previewInventoryImage,
    type InventoryVisionPreview,
} from "../src/inventory/vision.js";

function requireCondition(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function normalizedNames(preview: InventoryVisionPreview): string[] {
    return preview.lines.map((line) => line.name.trim().toLowerCase());
}

function hasAnyName(names: string[], fragments: string[]): boolean {
    return names.some((name) => fragments.some((fragment) => name.includes(fragment)));
}

const receiptPath =
    process.env.MUNCH_PANTRY_SMOKE_RECEIPT_PATH ?? "/tmp/munch-pantry-receipt.png";
const pantryPath =
    process.env.MUNCH_PANTRY_SMOKE_PANTRY_PATH ?? "/tmp/munch-pantry-scan.png";
const config = inventoryVisionConfig();

requireCondition(config, "Pantry vision smoke requires configured OpenRouter vision");

const receiptBytes = new Uint8Array(await Bun.file(receiptPath).arrayBuffer());
const pantryBytes = new Uint8Array(await Bun.file(pantryPath).arrayBuffer());

console.log(`Running Pantry vision receipt smoke with ${config.model}`);
const receipt = await previewInventoryImage(
    { mode: "receipt", mimeType: "image/png", bytes: receiptBytes },
    config,
);
const receiptNames = normalizedNames(receipt);
const receiptFood = receipt.lines.filter((line) => line.is_food);
const receiptNonFood = receipt.lines.filter((line) => !line.is_food);

requireCondition(receipt.lines.length >= 3, "Receipt smoke returned too few line items");
requireCondition(receiptFood.length >= 2, "Receipt smoke missed the food purchases");
requireCondition(
    receiptNonFood.length >= 1,
    "Receipt smoke did not classify the household item as non-food",
);
requireCondition(
    hasAnyName(receiptNames, ["sugar", "yogurt", "avocado"]),
    `Receipt smoke missed all expected food identities: ${receiptNames.join(", ")}`,
);
requireCondition(
    !receiptNames.some((name) => /\b(subtotal|total|tax|tender|payment)\b/.test(name)),
    `Receipt smoke incorrectly returned payment/summary rows: ${receiptNames.join(", ")}`,
);

console.log(
    `Receipt smoke passed: ${receiptFood.length} food line(s), ${receiptNonFood.length} non-food line(s).`,
);

console.log(`Running Pantry vision shelf smoke with ${config.model}`);
const pantry = await previewInventoryImage(
    { mode: "pantry_photo", mimeType: "image/png", bytes: pantryBytes },
    config,
);
const pantryNames = normalizedNames(pantry);
const expectedFragments = [
    "cottage cheese",
    "avocado",
    "ground beef",
    "olive oil",
    "spinach",
];
const matchedFragments = expectedFragments.filter((fragment) =>
    pantryNames.some((name) => name.includes(fragment)),
);

requireCondition(
    pantry.lines.filter((line) => line.is_food).length >= 3,
    `Pantry shelf smoke returned too few foods: ${pantryNames.join(", ")}`,
);
requireCondition(
    matchedFragments.length >= 3,
    `Pantry shelf smoke recognized only ${matchedFragments.length}/5 expected foods: ${pantryNames.join(", ")}`,
);

console.log(
    `Pantry shelf smoke passed: recognized ${matchedFragments.length}/5 expected food identities.`,
);
console.log("Live OpenRouter Pantry vision smoke passed.");
