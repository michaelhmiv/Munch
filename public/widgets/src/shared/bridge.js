// Shared MCP Apps / ChatGPT host bridge for every Munch widget.
function initWidget(config) {
    const rootId = config.rootId || "root";
    const root = () => document.getElementById(rootId);
    const host =
        window.parent && window.parent !== window ? window.parent : null;
    const pending = new Map();
    let nextRequestId = 0;
    let painted = false;
    let hostContext = {};
    let hostCapabilities = {};
    let hostInfo = {};

    function post(message) {
        try {
            if (host) host.postMessage(message, "*");
        } catch (_) {}
    }
    function notify(method, params) {
        post(
            params === undefined
                ? { jsonrpc: "2.0", method }
                : { jsonrpc: "2.0", method, params },
        );
    }
    function request(method, params, timeoutMs) {
        if (!host) return Promise.reject(new Error("no host"));
        const id = "munch-" + ++nextRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(
                    new Error(
                        `${method} timed out after ${timeoutMs || 60000}ms`,
                    ),
                );
            }, timeoutMs || 60000);
            pending.set(id, { resolve, reject, timer });
            post({ jsonrpc: "2.0", id, method, params: params || {} });
        });
    }
    function themeFrom(value) {
        if (!value || typeof value !== "object") return null;
        return (
            value.theme ||
            value.colorScheme ||
            value.hostContext?.theme ||
            value.globals?.theme ||
            null
        );
    }
    function applyTheme(theme) {
        if (theme === "light" || theme === "dark")
            document.documentElement.dataset.theme = theme;
    }
    function applyHostStyles(context) {
        const styles = context?.styles;
        if (!styles || typeof styles !== "object") return;
        const candidates = [styles.variables, styles.cssVariables, styles];
        for (const values of candidates) {
            if (!values || typeof values !== "object") continue;
            for (const [key, value] of Object.entries(values)) {
                if (
                    key.startsWith("--") &&
                    (typeof value === "string" || typeof value === "number")
                ) {
                    document.documentElement.style.setProperty(
                        key,
                        String(value),
                    );
                }
            }
        }
    }
    function applyContext(next) {
        if (!next || typeof next !== "object") return;
        hostContext = { ...hostContext, ...next };
        api.hostContext = hostContext;
        applyTheme(themeFrom(hostContext));
        applyHostStyles(hostContext);
        const mode = hostContext.displayMode || "inline";
        document.documentElement.dataset.displayMode = mode;
        if (hostContext.platform)
            document.documentElement.dataset.platform = hostContext.platform;
        if (typeof config.onHostContext === "function") {
            try {
                config.onHostContext(hostContext, api);
            } catch (_) {}
        }
    }
    function show(payload) {
        const data = config.coerce(payload);
        if (!data) return false;
        config.render(data, api);
        painted = true;
        return true;
    }
    function sendSize() {
        if (
            !host ||
            document.documentElement.dataset.displayMode === "fullscreen"
        )
            return;
        const height = Math.ceil(
            Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight,
            ),
        );
        notify("ui/notifications/size-changed", {
            width: Math.ceil(window.innerWidth),
            height,
        });
    }

    const api = {
        callTool(name, args, opts) {
            return request(
                "tools/call",
                { name, arguments: args || {} },
                opts?.timeoutMs || 60000,
            ).then((result) => {
                if (result?.isError) {
                    const text =
                        result.content?.find?.((part) => part?.type === "text")
                            ?.text || "Tool reported an error";
                    const error = new Error(text);
                    error.toolResult = result;
                    throw error;
                }
                return result;
            });
        },
        updateModelContext(text, structuredContent) {
            const params = {};
            if (text !== undefined && text !== null)
                params.content = [{ type: "text", text: String(text) }];
            if (structuredContent && typeof structuredContent === "object")
                params.structuredContent = structuredContent;
            return request("ui/update-model-context", params, 15000);
        },
        sendMessage(text) {
            return request(
                "ui/message",
                {
                    role: "user",
                    content: [{ type: "text", text: String(text) }],
                },
                15000,
            );
        },
        async requestDisplayMode(mode) {
            if (!host) {
                applyContext({ displayMode: mode });
                return { mode };
            }
            const available = hostContext.availableDisplayModes;
            if (Array.isArray(available) && !available.includes(mode))
                return {
                    mode: hostContext.displayMode || "inline",
                    unsupported: true,
                };
            try {
                const result = await request(
                    "ui/request-display-mode",
                    { mode },
                    15000,
                );
                applyContext({ displayMode: result?.mode || mode });
                return result || { mode };
            } catch (error) {
                return {
                    mode: hostContext.displayMode || "inline",
                    unsupported: true,
                    error: error?.message || "Display mode request failed",
                };
            }
        },
        canCallTools: false,
        canSendMessages: false,
        canUpdateModelContext: false,
        hostCapabilities,
        hostContext,
        hostInfo,
    };

    if (host && typeof ResizeObserver !== "undefined") {
        let scheduled = false;
        const observer = new ResizeObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                sendSize();
            });
        });
        observer.observe(document.documentElement);
        observer.observe(document.body);
    }

    window.addEventListener("message", (event) => {
        if (host && event.source !== host) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;

        if (
            message.id != null &&
            message.method === undefined &&
            ("result" in message || "error" in message)
        ) {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error)
                entry.reject(
                    new Error(
                        message.error.message || "Host returned an error",
                    ),
                );
            else entry.resolve(message.result);
            return;
        }

        if (typeof message.method === "string") {
            const params = message.params || {};
            if (message.method.endsWith("tool-result"))
                show(params.structuredContent || params);
            if (message.method.endsWith("host-context-changed"))
                applyContext(params.hostContext || params);
            else {
                const theme = themeFrom(params);
                if (theme) applyTheme(theme);
            }
            if (message.id != null)
                post({ jsonrpc: "2.0", id: message.id, result: {} });
            return;
        }

        if (
            "jsonrpc" in message ||
            ("id" in message && ("result" in message || "error" in message))
        )
            return;
        show(message.structuredContent || message);
    });

    if (host) {
        const el = root();
        if (el) el.innerHTML = config.loading || "";
        request(
            "ui/initialize",
            {
                protocolVersion: "2026-01-26",
                appInfo: {
                    name: config.name,
                    version:
                        config.version || "__MUNCH_WIDGET_APP_VERSION__",
                },
                appCapabilities: {
                    availableDisplayModes: config.displayModes || ["inline"],
                },
            },
            15000,
        )
            .then((result) => {
                notify("ui/notifications/initialized");
                hostCapabilities =
                    result?.hostCapabilities || result?.capabilities || {};
                hostInfo = result?.hostInfo || result?.serverInfo || {};
                api.hostCapabilities = hostCapabilities;
                api.hostInfo = hostInfo;
                api.canCallTools = !!hostCapabilities.serverTools;
                api.canSendMessages = !!hostCapabilities.message;
                api.canUpdateModelContext =
                    !!hostCapabilities.updateModelContext;
                applyContext(result?.hostContext || {});
                if (typeof config.onReady === "function") config.onReady(api);
            })
            .catch((error) => {
                console.warn("[munch-widget] initialize failed", error);
                if (!painted && root())
                    root().innerHTML =
                        '<div class="card empty"><strong>Unable to open this view</strong><span>Continue in chat and try again.</span></div>';
            });

        try {
            if (window.openai) {
                if (window.openai.theme) applyTheme(window.openai.theme);
                if (window.openai.toolOutput) show(window.openai.toolOutput);
            }
            window.addEventListener("openai:set_globals", (event) => {
                const globals = event.detail?.globals || event.detail || {};
                if (globals.theme) applyTheme(globals.theme);
                if (globals.displayMode)
                    applyContext({ displayMode: globals.displayMode });
                if (globals.toolOutput) show(globals.toolOutput);
            });
        } catch (_) {}
    } else {
        applyContext({
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
            platform: "web",
        });
        show(window.__WIDGET_DATA__ || config.sample);
        if (typeof config.onReady === "function") config.onReady(api);
    }
}
