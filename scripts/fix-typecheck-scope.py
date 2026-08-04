from pathlib import Path

# One-use GitHub Actions migration from a whole-repository diagnostic filter to
# a true production-source TypeScript project with a bounded compiler heap.
root = Path(__file__).resolve().parents[1]

(root / "tsconfig.src.json").write_text('''{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "allowJs": false
    },
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts"]
}
''')

(root / "scripts/typecheck.ts").write_text('''// Typecheck the production server sources only. Tests are compiled and executed
// by `bun test`; scripts have their own runtime smoke coverage. Keeping this as
// a real TypeScript project avoids loading generated assets and every test file
// into a single compiler process.

const proc = Bun.spawn(
    [
        "bunx",
        "tsc",
        "--project",
        "tsconfig.src.json",
        "--noEmit",
        "--pretty",
        "false",
    ],
    {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            NODE_OPTIONS: "--max-old-space-size=6144",
        },
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

console.log("Production src/ typechecks clean");
''')
