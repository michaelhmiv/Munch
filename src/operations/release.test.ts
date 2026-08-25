import { describe, expect, test } from "bun:test";
import { releaseMetadata } from "./release.js";

describe("release metadata", () => {
    test("exposes only non-sensitive release identity", () => {
        expect(
            releaseMetadata({
                RAILWAY_GIT_COMMIT_SHA: "abc123",
                RAILWAY_DEPLOYMENT_ID: "deployment-1",
                RAILWAY_ENVIRONMENT_NAME: "production",
                RAILWAY_SERVICE_ID: "service-1",
                DATABASE_URL: "postgresql://secret",
                BETTER_AUTH_SECRET: "secret",
            }),
        ).toEqual({
            service: "munch",
            git_sha: "abc123",
            deployment_id: "deployment-1",
            environment: "production",
            service_id: "service-1",
        });
    });

    test("falls back to GitHub SHA and NODE_ENV outside Railway", () => {
        expect(
            releaseMetadata({
                GITHUB_SHA: "def456",
                NODE_ENV: "test",
            }),
        ).toEqual({
            service: "munch",
            git_sha: "def456",
            deployment_id: null,
            environment: "test",
            service_id: null,
        });
    });

    test("returns null instead of exposing unknown configuration", () => {
        expect(releaseMetadata({})).toEqual({
            service: "munch",
            git_sha: null,
            deployment_id: null,
            environment: null,
            service_id: null,
        });
    });
});
