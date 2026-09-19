/**
 * Canonical persisted Cooks event types. Keep the PostgreSQL constraint in
 * db/updates/0032_cook_event_contract.sql in sync with this list.
 */
export const COOK_EVENT_TYPES = [
    "preparation",
    "season",
    "marinate",
    "preheat",
    "food_on",
    "temperature_change",
    "wrap",
    "unwrap",
    "sauce",
    "spritz",
    "turn",
    "reposition",
    "equipment_adjustment",
    "remove",
    "rest",
    "taste",
    "note",
    "correction",
    "custom",
] as const;

export type CookEventType = (typeof COOK_EVENT_TYPES)[number];

const supported = new Set<string>(COOK_EVENT_TYPES);
const aliases: Record<string, CookEventType> = {
    seasoning: "season",
    marinating: "marinate",
    marinade: "marinate",
    glaze: "sauce",
    glazing: "sauce",
    basting: "sauce",
    spray: "spritz",
    spraying: "spritz",
    spritzing: "spritz",
    food_off: "remove",
    food_removed: "remove",
    smoker_adjustment: "equipment_adjustment",
    grill_adjustment: "equipment_adjustment",
    thermometer: "temperature_change",
    temperature: "temperature_change",
    temperature_measurement: "temperature_change",
    resting: "rest",
    turning: "turn",
};

export function normalizeCookEventType(value: unknown): CookEventType {
    if (typeof value !== "string") {
        throw new Error("Cook event type must be text");
    }
    const name = value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    const canonical = aliases[name] ?? name;
    if (!supported.has(canonical)) {
        throw new Error(
            `Unsupported cook event type "${value}". Supported types: ${COOK_EVENT_TYPES.join(", ")}`,
        );
    }
    return canonical as CookEventType;
}
