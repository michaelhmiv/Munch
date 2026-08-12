import { test } from "bun:test";
import prettier from "prettier";

test("emit meal receipt Prettier line delta", async () => {
    const path = "public/widgets/src/templates/meal-logged.html";
    const input = await Bun.file(path).text();
    const config = (await prettier.resolveConfig(path)) ?? {};
    const output = await prettier.format(input, {
        ...config,
        parser: "html",
        filepath: path,
    });
    const before = input.split("\n");
    const after = output.split("\n");
    const limit = Math.max(before.length, after.length);
    for (let index = 0; index < limit; index += 1) {
        if (before[index] !== after[index]) {
            console.log(
                `MEAL_FMT_DIFF ${index + 1} BEFORE=${JSON.stringify(before[index] ?? null)} AFTER=${JSON.stringify(after[index] ?? null)}`,
            );
        }
    }
});
