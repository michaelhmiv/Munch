import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "business.munch.app",
    appName: "Munch",
    webDir: ".mobile-web",
    server: {
        hostname: "localhost",
        androidScheme: "https",
    },
    android: {
        allowMixedContent: false,
    },
};

export default config;
