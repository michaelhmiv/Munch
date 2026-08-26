import { RECIPE_IMPORTS_PER_MINUTE } from "../../src/recipe-import/fetch.js";

export function shardRecipeCorpus<T>(entries: readonly T[]): T[][] {
    const shards: T[][] = [];
    for (
        let index = 0;
        index < entries.length;
        index += RECIPE_IMPORTS_PER_MINUTE
    ) {
        shards.push(entries.slice(index, index + RECIPE_IMPORTS_PER_MINUTE));
    }
    return shards;
}
