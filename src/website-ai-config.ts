export const DEFAULT_WEBSITE_AI_MODEL = "qwen/qwen3.7-flash";

export function websiteAiModel(
    env: Record<string, string | undefined> = process.env,
): string {
    return env.MUNCH_AI_MODEL?.trim() || DEFAULT_WEBSITE_AI_MODEL;
}
