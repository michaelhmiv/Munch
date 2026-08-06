import { WIDGET_RESOURCE_METADATA } from "../src/openai-submission.js";

const errors: string[] = [];
const expectedDomain = "https://munch.business";

if (WIDGET_RESOURCE_METADATA.ui.domain !== expectedDomain) {
    errors.push(`Widget domain must be exactly ${expectedDomain}`);
}
if (WIDGET_RESOURCE_METADATA.ui.csp.connectDomains.length !== 0) {
    errors.push("Self-contained widgets must not declare connect domains");
}
if (WIDGET_RESOURCE_METADATA.ui.csp.resourceDomains.length !== 0) {
    errors.push("Self-contained widgets must not declare resource domains");
}

const resourceSources = ["src/mcp.ts", "src/meal-review-tools.ts"];
let htmlResourceCount = 0;
let cspMetadataCount = 0;
for (const path of resourceSources) {
    const source = await Bun.file(path).text();
    htmlResourceCount +=
        source.match(/text:\s*await getWidgetHtml\(/g)?.length ?? 0;
    cspMetadataCount +=
        source.match(/_meta:\s*WIDGET_RESOURCE_METADATA/g)?.length ?? 0;
}
if (htmlResourceCount === 0) errors.push("No widget resources were discovered");
if (cspMetadataCount !== htmlResourceCount) {
    errors.push(
        `Found ${htmlResourceCount} widget HTML resources but ${cspMetadataCount} explicit CSP metadata blocks`,
    );
}

const externalAssetPattern =
    /<(?:script|img|iframe|link)\b[^>]*(?:src|href)=["']https?:\/\//i;
const directNetworkPattern =
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
const wildcardNetworkUrlPattern = /https?:\/\/\*|wss?:\/\/\*/i;
const widgetGlob = new Bun.Glob("public/widgets/**/*.{html,js,ts,css}");
for await (const path of widgetGlob.scan({ cwd: "." })) {
    const source = await Bun.file(path).text();
    if (externalAssetPattern.test(source)) {
        errors.push(`${path}: contains a direct external asset URL`);
    }
    if (directNetworkPattern.test(source)) {
        errors.push(`${path}: performs a direct network request`);
    }
    if (wildcardNetworkUrlPattern.test(source)) {
        errors.push(`${path}: contains a wildcard network URL`);
    }
}

if (errors.length > 0) {
    console.error("Widget CSP audit failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(
    `Widget CSP audit passed for ${htmlResourceCount} self-contained resources.`,
);
