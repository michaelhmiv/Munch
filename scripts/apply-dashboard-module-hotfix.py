from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


routes_path = Path("src/app/routes.ts")
routes = routes_path.read_text()
routes = replace_once(
    routes,
    '''    app.get("/app.js", async (c) =>
        c.body(await Bun.file("./public/app.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
''',
    '''    app.get("/app.js", async (c) =>
        c.body(await Bun.file("./public/app.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
    app.get("/weight-display.js", async (c) =>
        c.body(await Bun.file("./public/weight-display.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
''',
    "weight display asset route",
)
routes_path.write_text(routes)

smoke_path = Path("scripts/ui-surface-smoke.ts")
smoke = smoke_path.read_text()
smoke = replace_once(
    smoke,
    '    "public/app-patches.js",\n',
    '    "public/app-patches.js",\n    "public/weight-display.js",\n',
    "required browser module",
)
smoke = replace_once(
    smoke,
    '''const appHtml = await Bun.file("public/app.html").text();
''',
    '''const appRouterSource = await Bun.file("src/app/routes.ts").text();
const browserEntryPoints = ["public/app.js", "public/app-patches.js"];
for (const entryPoint of browserEntryPoints) {
    const source = await Bun.file(entryPoint).text();
    for (const match of source.matchAll(/from\\s+["']\\.\\/([^"']+\\.js)["']/g)) {
        const moduleName = match[1];
        const publicPath = `public/${moduleName}`;
        const route = `/${moduleName}`;
        if (!(await Bun.file(publicPath).exists())) {
            throw new Error(`${entryPoint} imports missing browser module ${publicPath}`);
        }
        if (!appRouterSource.includes(`app.get("${route}"`)) {
            throw new Error(`${entryPoint} imports ${route}, but the app router does not serve it`);
        }
    }
}

const appHtml = await Bun.file("public/app.html").text();
''',
    "browser module route smoke",
)
smoke_path.write_text(smoke)
