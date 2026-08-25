from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected marker missing in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, count))


replace(
    "src/inventory/planning-profile.ts",
    '''async function persistProfile(
    userId: string,
    profile: Omit<PantryPlanningProfile, "updated_at" | "enriched_at">,
): Promise<PantryPlanningProfile> {
    return withUserDatabase(userId, async (tx) => {
        const n = profile.nutrients;''',
    '''function postgresTextArrayLiteral(values: string[]): string {
    return `{${values
        .map(
            (value) =>
                `"${value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"')}"`,
        )
        .join(",")}}`;
}

async function persistProfile(
    userId: string,
    profile: Omit<PantryPlanningProfile, "updated_at" | "enriched_at">,
): Promise<PantryPlanningProfile> {
    return withUserDatabase(userId, async (tx) => {
        const n = profile.nutrients;
        const culinaryRoles = postgresTextArrayLiteral(profile.culinary_roles);''',
)
replace(
    "src/inventory/planning-profile.ts",
    '${profile.category}, ${profile.culinary_roles}::text[],',
    '${profile.category}, ${culinaryRoles}::text[],',
)
replace(
    "src/inventory/planning-profile.ts",
    '''    const ids = [...new Set(inventoryItemIds)].slice(0, 200);
    if (!ids.length) return new Map();
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_item_profiles
            where inventory_item_id = any(${ids}::uuid[])
        `;''',
    '''    const ids = [...new Set(inventoryItemIds)].slice(0, 200);
    if (!ids.length) return new Map();
    const idsLiteral = `{${ids.join(",")}}`;
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_item_profiles
            where inventory_item_id = any(${idsLiteral}::uuid[])
        `;''',
)

replace(
    "scripts/pantry-planning-smoke.ts",
    '''        await tx`
            insert into munch.inventory_item_profiles (''',
    '''        const rolesLiteral = `{${profile.roles.join(",")}}`;
        await tx`
            insert into munch.inventory_item_profiles (''',
    1,
)
replace(
    "scripts/pantry-planning-smoke.ts",
    '${profile.category}, ${profile.roles}::text[],',
    '${profile.category}, ${rolesLiteral}::text[],',
)
replace(
    "scripts/pantry-planning-smoke.ts",
    '${["protein"]}::text[], 1)',
    '${"{protein}"}::text[], 1)',
)
replace(
    "scripts/account-export-smoke.ts",
    '${["creamy", "dairy", "protein"]}::text[],',
    '${"{creamy,dairy,protein}"}::text[],',
)

print("Pantry Postgres array serialization fix applied.")
