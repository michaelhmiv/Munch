import { test } from "bun:test";
import prettier from "prettier";

const targets = [
    ["public/app.html", "html"],
    ["public/widgets/src/templates/meal-logged.html", "html"],
    ["src/ui-density.test.ts", "typescript"],
] as const;

test("emit repository-exact Prettier output for progressive-density files", async () => {
    for (const [path, parser] of targets) {
        const input = await Bun.file(path).text();
        const config = (await prettier.resolveConfig(path)) ?? {};
        const formatted = await prettier.format(input, {
            ...config,
            parser,
            filepath: path,
        });
        console.log(
            `DENSITY_FORMAT_B64::${path}::${Buffer.from(formatted, "utf8").toString("base64")}`,
        );
    }
});
