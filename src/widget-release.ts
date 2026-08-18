// One release identity for ChatGPT/MCP UI surfaces.
//
// MUNCH_APP_VERSION is reported by widget ui/initialize and by the MCP server so
// logs and host diagnostics identify the deployed UI generation consistently.
// MUNCH_WIDGET_RESOURCE_VERSION is part of every ui:// resource URI because the
// host is allowed to cache those resources by URI. Breaking HTML/CSS/JS changes
// must therefore publish a new URI instead of changing bytes behind an old key.
export const MUNCH_APP_VERSION = "0.9.0";
export const MUNCH_WIDGET_RESOURCE_VERSION = "v2";
