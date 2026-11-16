import type { Sandbox } from "./sanbox";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function discoverGates(sandbox: Sandbox): Promise<string[]> {
  try {
    const pkg = JSON.parse(await sandbox.readFile("package.json")) as PackageJson;
    const scripts = pkg.scripts ?? {};
    const gates: string[] = [];

    if (scripts.typecheck || scripts["type-check"]) {
      gates.push("bun run typecheck");
    } else if (
      pkg.devDependencies?.typescript ||
      pkg.dependencies?.typescript
    ) {
      gates.push("bun check");
    }

    if (scripts.lint) gates.push("bun run lint");
    if (scripts.test) gates.push("bun test");
    if (scripts.build) gates.push("bun run build");

    return gates;
  } catch {
    return [];
  }
}
