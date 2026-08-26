import { describe, expect, test } from "bun:test";
import { RECIPE_IMPORTS_PER_MINUTE } from "../../src/recipe-import/fetch.js";
import { shardRecipeCorpus } from "./recipe-corpus-sharding.js";

describe("production recipe certification sharding", () => {
    test("keeps every shard within the real per-user import limit", () => {
        const corpus = Array.from({ length: 26 }, (_, index) => index);
        const shards = shardRecipeCorpus(corpus);
        expect(shards.map((shard) => shard.length)).toEqual([10, 10, 6]);
        expect(shards.every((shard) => shard.length <= RECIPE_IMPORTS_PER_MINUTE)).toBe(true);
        expect(shards.flat()).toEqual(corpus);
    });

    test("does not create empty shards", () => {
        expect(shardRecipeCorpus([])).toEqual([]);
    });
});
