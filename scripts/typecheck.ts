// Typecheck the production server sources with Microsoft's native TypeScript
// compiler. The JavaScript compiler exceeded the GitHub runner heap on the MCP
// tool-schema graph even when scoped to src/; tsgo performs the same validation
// without relying on Node's V8 heap.

const proc = Bun.spawn(
    [
        "./node_modules/.bin/tsgo",
        "--project",
        "tsconfig.src.json",
        "--noEmit",
        "--pretty",
        "false",
    ],
    {
        stdout: "inherit",
        stderr: "inherit",
    },
);

const startedAt = Date.now();
const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`Typecheck still running (${elapsedSeconds}s)`);
}, 30_000);

const exitCode = await proc.exited;
clearInterval(heartbeat);

if (exitCode !== 0) {
    process.exit(exitCode);
}

console.log("Production src/ typechecks clean with tsgo");
