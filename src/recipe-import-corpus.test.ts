import { describe, expect, test } from "bun:test";
import {
    RECIPE_IMPORT_CORPUS,
    RECIPE_IMPORT_CORPUS_HOSTS,
} from "./recipe-import/fixtures/recipe-corpus.js";

describe("recipe import live corpus", () => {
    test("contains twenty distinct recipe sites with direct HTTPS URLs", () => {
        expect(RECIPE_IMPORT_CORPUS).toHaveLength(20);
        expect(RECIPE_IMPORT_CORPUS_HOSTS).toHaveLength(20);
        expect(
            new Set(RECIPE_IMPORT_CORPUS.map((entry) => entry.id)),
        ).toHaveLength(20);
        expect(
            RECIPE_IMPORT_CORPUS.every((entry) => {
                const url = new URL(entry.url);
                return url.protocol === "https:" && entry.patterns.length > 0;
            }),
        ).toBe(true);
    });

    test("does not contain roundup or directory URLs", () => {
        expect(
            RECIPE_IMPORT_CORPUS.some((entry) =>
                /\/recipes\/?$|\/recipe-index\/?$|\/category\//i.test(
                    new URL(entry.url).pathname,
                ),
            ),
        ).toBe(false);
    });
});
