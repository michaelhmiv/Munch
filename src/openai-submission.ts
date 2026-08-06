import { PRODUCT_CONFIG } from "./product-config.js";

export const WIDGET_RESOURCE_METADATA = {
    ui: {
        prefersBorder: true,
        domain: PRODUCT_CONFIG.publicBaseUrl,
        csp: {
            connectDomains: [] as string[],
            resourceDomains: [] as string[],
        },
    },
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
