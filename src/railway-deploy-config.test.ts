import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function read(path: string): string {
    return readFileSync(`${root}${path}`, "utf8");
}

describe("Railway production deployment contract", () => {
    test("keeps build, pre-deploy, and startup behavior source-controlled", () => {
        const config = JSON.parse(read("railway.json")) as {
            build?: { builder?: string; dockerfilePath?: string };
            deploy?: {
                preDeployCommand?: string;
                startCommand?: string;
                healthcheckPath?: string;
            };
        };

        expect(config.build).toEqual({
            builder: "DOCKERFILE",
            dockerfilePath: "Dockerfile",
        });
        expect(config.deploy?.preDeployCommand).toBe(
            "bash scripts/predeploy-production.sh",
        );
        expect(config.deploy?.startCommand).toBe("bun --smol src/index.ts");
        expect(config.deploy?.healthcheckPath).toBe("/health/ready");
    });

    test("runs migrations before an explicitly gated USDA seed", () => {
        const script = read("scripts/predeploy-production.sh");
        const migration = script.indexOf("bun run db:migrate");
        const seedSwitch = script.indexOf('seed_mode="${MUNCH_USDA_SEED_MODE:-off}"');

        expect(migration).toBeGreaterThan(-1);
        expect(seedSwitch).toBeGreaterThan(migration);
        expect(script).toContain("dry-run)");
        expect(script).toContain("seed)");
        expect(script).toContain("scripts/seed-usda-generic-catalog.sh --dry-run");
        expect(script).toContain("scripts/seed-usda-generic-catalog.sh seed");
        expect(script).toContain("exit 2");
    });

    test("keeps the serving process independent from one-off seed work", () => {
        const dockerfile = read("Dockerfile");
        expect(dockerfile).toContain('CMD ["bun", "--smol", "src/index.ts"]');
        expect(dockerfile).not.toContain("start-production.sh");
        expect(existsSync(`${root}scripts/start-production.sh`)).toBe(false);
    });
});
