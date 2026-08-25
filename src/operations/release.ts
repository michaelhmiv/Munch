export interface ReleaseMetadata {
    service: "munch";
    git_sha: string | null;
    deployment_id: string | null;
    environment: string | null;
    service_id: string | null;
}

function firstValue(
    env: Record<string, string | undefined>,
    ...names: string[]
): string | null {
    for (const name of names) {
        const value = env[name]?.trim();
        if (value) return value;
    }
    return null;
}

export function releaseMetadata(
    env: Record<string, string | undefined> = process.env,
): ReleaseMetadata {
    return {
        service: "munch",
        git_sha: firstValue(env, "RAILWAY_GIT_COMMIT_SHA", "GITHUB_SHA"),
        deployment_id: firstValue(env, "RAILWAY_DEPLOYMENT_ID"),
        environment: firstValue(
            env,
            "RAILWAY_ENVIRONMENT_NAME",
            "RAILWAY_ENVIRONMENT",
            "NODE_ENV",
        ),
        service_id: firstValue(env, "RAILWAY_SERVICE_ID"),
    };
}
