// Typecheck the production server sources with Microsoft's native TypeScript
// compiler. The JavaScript compiler exceeded the GitHub runner heap on the MCP
// tool-schema graph even when scoped to src/; tsgo performs the same validation
// without relying on Node's V8 heap.

const proc = Bun.spawn(
    [
        "bunx",
        "tsgo",
        "--project",
        "tsconfig.src.json",
        "--noEmit",
        "--pretty",
        "false",
    ],
    {
        stdout: "pipe",
        stderr: "pipe",
    },
);
const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
]);

if (exitCode !== 0) {
    console.error(stdout + stderr);
    process.exit(1);
}

console.log("Production src/ typechecks clean with tsgo");
