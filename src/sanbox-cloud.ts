import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { resolve } from "node:path";
import type { Sandbox } from "./sanbox";

 
export async function createCloudSandbox(config: {
  template?: string;
  snapshotId?: string;
}): Promise<Sandbox> {
  const vm = await VercelSandbox.create({ ...config, timeout: 30 * 60 * 1000 });
 
  return {
    type: "cloud",
    workingDirectory: "/workspace",
    expiresAt: vm.expiresAt?.getTime(),
 
    readFile: async (p) => {
      const content = await vm.readFileToBuffer({
        path: resolve("/workspace", p),
      });
      return content?.toString("utf-8") ?? "";
    },
 
    exec: async (command) => {
      const result = await vm.runCommand({
        cmd: "sh",
        args: ["-c", command],
        cwd: "/workspace",
      });
      return {
        stdout: (await result.stdout()) + (await result.stderr()),
        exitCode: result.exitCode,
      };
    },
 
    stop: async () => {
      await vm.stop();
    },
 
    snapshot: async () => {
      const snap = await vm.snapshot();
      return { snapshotId: snap.snapshotId };
    },
  };
}