
import { stepCountIs, tool, ToolLoopAgent } from "ai";
import z from "zod";
import type { Sandbox } from "./sanbox";
import { groq } from "@ai-sdk/groq";

const MAX_OUTPUT_CHARS = 12_000;
const MAX_LINES = 500;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return (
    output.slice(0, MAX_OUTPUT_CHARS) +
    "\n\n... Output truncated. Narrow your search or read a smaller section."
  );
}

export function createReadTool(sandbox: Sandbox) {
  return tool({
    description: `Read a file from the project. Returns numbered lines.
WHEN TO USE: viewing file contents, checking configs, reading source code.
WHEN NOT TO USE: searching across files (use grep instead).`,
    inputSchema: z.object({
      path: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_LINES).optional(),
    }),
    execute: async ({ path, offset = 0, limit = MAX_LINES }) => {
      const content = await sandbox.readFile(path);
      const lines = content.split("\n");

      const result = lines
        .slice(offset, offset + limit)
        .map((line, index) => `${offset + index + 1}: ${line}`)
        .join("\n");

      return truncateOutput(result || "(empty file)");
    },
  });
}

export function createGrepTool(sandbox: Sandbox) {
  return tool({
    description: `Search for a pattern across project files.
WHEN TO USE: finding symbols, references, TODO comments, or matching text.
WHEN NOT TO USE: reading a specific file (use read instead).
Returns matching lines with file names and line numbers.`,
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    execute: async ({ pattern, path, glob }) => {
      // Escape shell arguments to prevent shell injection.
      const quote = (value: string) =>
        `'${value.replace(/'/g, "'\\''")}'`;

      const searchPath = path || ".";
      const globFilter = glob ? `-name ${quote(glob)}` : "";
      const command = `find ${quote(searchPath)} -type f ${globFilter} -exec grep -nH -- ${quote(pattern)} {} +`;

      const { stdout, exitCode } = await sandbox.exec(command);

      if (exitCode === 1) {
        return "No matches found.";
      }

      if (exitCode !== 0 && !stdout) {
        return `Search failed with exit code ${exitCode}.`;
      }

      const matches = stdout.split("\n").filter(Boolean);
      const limited = matches.slice(0, 50).join("\n");

      return truncateOutput(
        limited || "No matches found."
      ) + (matches.length > 50
        ? `\n\n... ${matches.length - 50} more matches omitted.`
        : "");
    },
  });
}

export function createBashTool(
  sandbox: Sandbox,
  requiresApproval: (input: { command: string }) => boolean,
) {
  const MAX_BASH_CHARS = 5000;
  return tool({
    description: `Execute a shell command in the working directory.
WHEN TO USE: build commands, package install, tests, git, directory listings.
WHEN NOT TO USE: reading file contents (use read).
DO NOT USE FOR: reading files (use read), searching code (use grep).`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (requiresApproval({ command })) {
        return `Blocked: "${command}" requires approval.`;
      }
      const result = await sandbox.exec(command);
      const stdout = result.stdout || "(no output)";
      return stdout.length > MAX_BASH_CHARS
        ? stdout.slice(-MAX_BASH_CHARS) +
        `\n... (truncated, showing last ${MAX_BASH_CHARS} chars)`
        : stdout;
    },
  });
}
 
export function createTaskTool(
  sandbox: Sandbox,
  parentTools: { read: any; grep: any; executorBash: any },
) {
  return tool({
    description: `Delegate work to a subagent.
WHEN TO USE: investigating a codebase, finding patterns, gathering context.
Explorer: read-only research with a fast model.
Executor: implementation with delegated Bash access and a larger step budget.
WHEN NOT TO USE: tasks that need decisions or askUser interactions.`,
    inputSchema: z.object({
      description: z.string().describe("What the subagent should investigate"),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Subagent role"),
    }),
    execute: async ({ description, subagentType }) => {
      if (subagentType === "executor") {
        const executor = new ToolLoopAgent({
          model: groq("openai/gpt-oss-120b"),
          instructions: `You are an executor agent. Follow instructions precisely.
Working directory: ${sandbox.workingDirectory}
Use the available tools to implement the requested changes and verify them.
Do not ask questions; report blockers clearly instead.`,
          tools: {
            read: parentTools.read,
            grep: parentTools.grep,
            bash: parentTools.executorBash,
          },
          stopWhen: stepCountIs(15),
        });

        try {
          const { text, steps } = await executor.generate({ prompt: description });
          return text
            ? `[Executor: ${steps.length} steps]\n${text}`
            : "(no response from executor)";
        } catch (e: any) {
          return `Executor error: ${e.message}`;
        }
      }

      const explorer = new ToolLoopAgent({
        model: groq("openai/gpt-oss-20b"),
        instructions: `You are an explorer agent. Investigate and report back concisely.
Working directory: ${sandbox.workingDirectory}`,
        tools: { read: parentTools.read, grep: parentTools.grep },
        stopWhen: stepCountIs(5),
      });
 
      try {
        const { text, steps } = await explorer.generate({ prompt: description });
        return text
          ? `[Explorer: ${steps.length} steps]\n${text}`
          : "(no response from subagent)";
      } catch (e: any) {
        return `Subagent error: ${e.message}`;
      }
    },
  });
}