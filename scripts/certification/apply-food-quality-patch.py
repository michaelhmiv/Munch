from pathlib import Path
import re

# catalog-repository.ts
path = Path("src/food-providers/catalog-repository.ts")
text = path.read_text()
if 'import { isValidGtin } from "./barcode.js";' not in text:
    anchor = 'import { createHash } from "node:crypto";\n'
    text = text.replace(anchor, anchor + 'import { isValidGtin } from "./barcode.js";\nimport { rankCandidates } from "./ranking.js";\n', 1)
text = text.replace(
    'if (candidate.barcode && !/^[0-9]{8,14}$/.test(candidate.barcode)) {\n        throw new Error("Invalid barcode");\n    }',
    'if (candidate.barcode && !isValidGtin(candidate.barcode)) {\n        throw new Error("Invalid barcode");\n    }',
    1,
)
if 'private readonly pendingTouchIds = new Set<string>();' not in text:
    ctor = 'export class FoodCatalogRepository {\n    constructor(private readonly config: CatalogConfig) {}\n'
    replacement = '''export class FoodCatalogRepository {
    private readonly pendingTouchIds = new Set<string>();
    private touchTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly config: CatalogConfig) {}

    private scheduleTouch(ids: string[]): void {
        if (!this.config.writesEnabled || ids.length === 0) return;
        for (const id of ids) this.pendingTouchIds.add(id);
        if (this.touchTimer) return;
        this.touchTimer = setTimeout(() => {
            const pending = [...this.pendingTouchIds];
            this.pendingTouchIds.clear();
            this.touchTimer = null;
            void this.touch(pending).catch((error) => {
                console.warn(
                    `[food_catalog] access_touch_failed count=${pending.length} code=${error instanceof Error ? error.name : "unknown"}`,
                );
            });
        }, 250);
        this.touchTimer.unref?.();
    }
'''
    if ctor not in text:
        raise SystemExit('catalog constructor anchor changed')
    text = text.replace(ctor, replacement, 1)

pattern = re.compile(r'''    async searchLocal\(query: string, limit: number\): Promise<CatalogHit\[]> \{.*?\n    \}\n\n    async findCachedSearch''', re.S)
replacement = '''    async searchLocal(query: string, limit: number): Promise<CatalogHit[]> {
        if (!this.config.readsEnabled) return [];
        const normalized = normalizeFoodText(query);
        if (!normalized) return [];
        const boundedLimit = Math.max(1, Math.min(25, limit));
        const retrievalLimit = Math.min(100, Math.max(25, boundedLimit * 5));
        const rows = await withServiceDatabase(
            async (tx) =>
                tx<CatalogRow[]>`
                select id, provider, provider_food_id, source_snapshot, refresh_after
                from munch.food_catalog_entries
                where deprecated_at is null
                  and (
                    to_tsvector(
                        'simple',
                        normalized_name || ' ' || coalesce(normalized_brand, '')
                    ) @@ plainto_tsquery('simple', ${normalized})
                    or normalized_name % ${normalized}
                    or normalized_name like ${`%${normalized}%`}
                    or coalesce(normalized_brand, '') % ${normalized}
                  )
                order by
                    case when normalized_name = ${normalized} then 0 else 1 end,
                    ts_rank_cd(
                        to_tsvector(
                            'simple',
                            normalized_name || ' ' || coalesce(normalized_brand, '')
                        ),
                        plainto_tsquery('simple', ${normalized})
                    ) desc,
                    greatest(
                        similarity(normalized_name, ${normalized}),
                        similarity(coalesce(normalized_brand, ''), ${normalized})
                    ) desc,
                    confidence desc,
                    length(normalized_name) asc
                limit ${retrievalLimit}
            `,
        );
        const now = Date.now();
        const hits = rows.flatMap((row) => {
            const hit = hitFromRow(row, now);
            return hit ? [hit] : [];
        });
        const ranked = rankCandidates(
            { query: normalized },
            hits.map((hit) => hit.candidate),
        );
        const order = new Map(
            ranked.map((candidate, index) => [
                `${candidate.provider}:${candidate.providerFoodId}`,
                index,
            ]),
        );
        const selected = hits
            .sort(
                (left, right) =>
                    (order.get(
                        `${left.candidate.provider}:${left.candidate.providerFoodId}`,
                    ) ?? Number.MAX_SAFE_INTEGER) -
                    (order.get(
                        `${right.candidate.provider}:${right.candidate.providerFoodId}`,
                    ) ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(0, boundedLimit);
        this.scheduleTouch(selected.map((hit) => {
            const row = rows.find(
                (entry) =>
                    entry.provider === hit.candidate.provider &&
                    entry.provider_food_id === hit.candidate.providerFoodId,
            );
            return row?.id ?? "";
        }).filter(Boolean));
        return selected;
    }

    async findCachedSearch'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit('searchLocal anchor changed')
text = text.replace(
    '        await this.touch(rows.map((row) => row.id));\n',
    '        this.scheduleTouch(rows.map((row) => row.id));\n',
    1,
)
path.write_text(text)

# service.ts
path = Path("src/food-providers/service.ts")
text = path.read_text()
if 'import { normalizeGtin } from "./barcode.js";' not in text:
    anchor = 'import { foodCatalogConfig } from "./catalog-config.js";\n'
    text = text.replace(anchor, anchor + 'import { normalizeGtin } from "./barcode.js";\n', 1)
text = text.replace(
    '            const cachedFresh = freshCandidates(cachedHits);',
    '            const cachedFresh = rankCandidates(\n                { query: normalized },\n                freshCandidates(cachedHits),\n            );',
    1,
)
text = text.replace(
    '        const local = freshCandidates(localHits);',
    '        const local = rankCandidates(\n            { query: normalized },\n            freshCandidates(localHits),\n        );',
    1,
)
old = '''        const digits = barcode.replace(/\\D/g, "");
        if (digits.length < 8 || digits.length > 14) {
            return { candidates: [], failures: [] };
        }'''
new = '''        const digits = normalizeGtin(barcode);
        if (!digits) return { candidates: [], failures: [] };'''
if old not in text:
    raise SystemExit('service barcode normalization anchor changed')
text = text.replace(old, new, 1)
path.write_text(text)

# USDA provider
path = Path("src/food-providers/usda.ts")
text = path.read_text()
if 'import { normalizeGtin } from "./barcode.js";' not in text:
    anchor = 'import { FoodProviderError } from "./errors.js";\n'
    text = text.replace(anchor, 'import { normalizeGtin } from "./barcode.js";\n' + anchor, 1)
text = text.replace(
    'const barcode = food.gtinUpc?.replace(/\\D/g, "") || undefined;',
    'const barcode = normalizeGtin(food.gtinUpc ?? "") ?? undefined;',
)
old = '''        const barcode = input.barcode.replace(/\\D/g, "");
        if (barcode.length < 8 || barcode.length > 14) return null;'''
new = '''        const barcode = normalizeGtin(input.barcode);
        if (!barcode) return null;'''
if old not in text:
    raise SystemExit('USDA barcode lookup anchor changed')
text = text.replace(old, new, 1)
path.write_text(text)

# Open Food Facts provider
path = Path("src/food-providers/open-food-facts.ts")
text = path.read_text()
if 'import { normalizeGtin } from "./barcode.js";' not in text:
    anchor = 'import { gramsFromDrink } from "../alcohol.js";\n'
    text = text.replace(anchor, anchor + 'import { normalizeGtin } from "./barcode.js";\n', 1)
pattern = re.compile(r'''function normalizedBarcode\(value: unknown\): string \| undefined \{.*?\n\}\n''', re.S)
text, count = pattern.subn('''function normalizedBarcode(value: unknown): string | undefined {
    return normalizeGtin(String(value ?? "")) ?? undefined;
}
''', text, count=1)
if count != 1:
    raise SystemExit('OFF barcode helper anchor changed')
path.write_text(text)

# Legacy foods.ts
path = Path("src/foods.ts")
text = path.read_text()
if 'import { normalizeGtin } from "./food-providers/barcode.js";' not in text:
    anchor = 'import { cacheFood, getCachedFood as readCachedFood } from "./storage.js";\n'
    text = text.replace(anchor, anchor + 'import { normalizeGtin } from "./food-providers/barcode.js";\n', 1)
pattern = re.compile(r'''export function normalizeBarcode\(raw: string\): string \| null \{.*?\n\}\n''', re.S)
text, count = pattern.subn('''export function normalizeBarcode(raw: string): string | null {
    return normalizeGtin(raw);
}
''', text, count=1)
if count != 1:
    raise SystemExit('legacy normalizeBarcode anchor changed')
path.write_text(text)

# Tighten production corpus invalid barcode contract.
path = Path("scripts/certification/production-mcp-corpus.ts")
text = path.read_text()
old = '''            const candidates = call.result.structuredContent?.candidates as
                Array<Record<string, unknown>> | undefined;
            rows.push({
                barcode,
                attempt,
                duration_ms: call.duration_ms,
                candidates: candidates?.length ?? 0,
                top_name: candidates?.[0]?.name ?? null,
                provider_failures: Array.isArray(
                    call.result.structuredContent?.provider_failures,
                )
                    ? call.result.structuredContent.provider_failures.length
                    : 0,
            });'''
new = '''            const candidates = call.result.structuredContent?.candidates as
                Array<Record<string, unknown>> | undefined;
            if (barcode === "000000000000" && (candidates?.length ?? 0) !== 0) {
                throw new Error("All-zero GTIN unexpectedly resolved to a food");
            }
            rows.push({
                barcode,
                attempt,
                duration_ms: call.duration_ms,
                candidates: candidates?.length ?? 0,
                top_name: candidates?.[0]?.name ?? null,
                provider_failures: Array.isArray(
                    call.result.structuredContent?.provider_failures,
                )
                    ? call.result.structuredContent.provider_failures.length
                    : 0,
            });'''
if old not in text:
    raise SystemExit('cert barcode row anchor changed')
text = text.replace(old, new, 1)
path.write_text(text)
