from pathlib import Path
import json
import subprocess

# One-use GitHub Actions migration from the memory-bound JavaScript compiler to
# Microsoft's native TypeScript compiler for the production source project.
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

package_path = root / "package.json"
package = json.loads(package_path.read_text())
package.setdefault("devDependencies", {})["@typescript/native-preview"] = "7.0.0-dev.20260707.2"
package_path.write_text(json.dumps(package, indent=4) + "\n")
subprocess.run(["bun", "install"], cwd=root, check=True)

(root / "scripts/typecheck.ts").write_text('''// Typecheck the production server sources with Microsoft's native TypeScript
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
''')
