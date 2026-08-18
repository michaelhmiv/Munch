import { z } from "zod";
import { PRODUCT_CONFIG } from "./product-config.js";

export const TEXT_OUTPUT_SCHEMA = {
    text: z.string(),
};

export const WIDGET_RESOURCE_METADATA = {
    ui: {
        // Munch renders its own single card surface. Asking the ChatGPT host for
        // an additional border creates the empty nested-card moat that the
        // widget style guide explicitly forbids.
        prefersBorder: false,
        domain: PRODUCT_CONFIG.publicBaseUrl,
        csp: {
            connectDomains: [] as string[],
            resourceDomains: [] as string[],
        },
    },
    // Compatibility alias for ChatGPT hosts that still read the OpenAI-specific
    // metadata field instead of the MCP Apps standard ui.prefersBorder field.
    "openai/widgetPrefersBorder": false,
};

export function widgetToolMeta(resourceUri: string): {
    _meta: { ui: { resourceUri: string } };
} {
    return { _meta: { ui: { resourceUri } } };
}

export function openAiAppsChallenge(
    value = process.env.OPENAI_APPS_CHALLENGE,
): string | null {
    const challenge = value?.trim();
    return challenge ? challenge : null;
}
