
import { stepCountIs, tool, ToolLoopAgent } from "ai";
import z from "zod";
import { readFileSync } from "node:fs";
import type { Sandbox } from "./sanbox";
import { groq } from "@ai-sdk/groq";
import type { Skill } from "./skills";

const MAX_OUTPUT_CHARS = 12_000;
const MAX_LINES = 500;

interface TodoItem {
  id: string;
  description: string;
  state: "pending" | "in_progress" | "completed";
}

const todos: TodoItem[] = [];

export function createAskUserTool() {
  return tool({
    description: `Ask the user a multiple-choice question.
WHEN TO USE: scoping ambiguous tasks, choosing between approaches,
  resolving a missing detail before acting.
WHEN NOT TO USE: you already have enough context to proceed.
DO NOT USE FOR: rhetorical questions or progress updates.`,
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      options: z
        .array(z.string())
        .min(2)
        .max(4)
        .describe("Two to four options for the user to pick from"),
    }),
    execute: async ({ question, options }) => {
      const formatted = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
      console.log(`\nQuestion: ${question}\n${formatted}\n`);
      return `Asked: "${question}"\nOptions:\n${formatted}\n\n(Awaiting user response.)`;
    },
  });
}

export function createTodoTool() {
  return tool({
    description: `Manage a task list for multi-step work.
WHEN TO USE: tasks with 3+ steps, multiple files, or dependencies between
  changes. Plan once, then track progress as you go.
WHEN NOT TO USE: single-file fixes, simple questions, exploratory reads.
DO NOT USE FOR: status updates to the user (just answer them directly).`,
    inputSchema: z.object({
      action: z.enum(["add", "start", "complete", "list"]),
      description: z.string().optional(),
      id: z.string().optional(),
    }),
    execute: async ({ action, description, id }) => {
      if (action === "add") {
        const item: TodoItem = {
          id: crypto.randomUUID().slice(0, 8),
          description: description ?? "(unnamed)",
          state: "pending",
        };
        todos.push(item);
        return `Added: [${item.id}] ${item.description}`;
      }

      if (action === "start") {
        const active = todos.find((item) => item.state === "in_progress");
        if (active) {
          return `Already working on: [${active.id}] ${active.description}. Complete it first.`;
        }

        const next = todos.find((item) => item.id === id);
        if (next) {
          next.state = "in_progress";
          return `Started: [${next.id}] ${next.description}`;
        }
        return `No todo with id ${id}.`;
      }

      if (action === "complete") {
        const item = todos.find((todo) => todo.id === id);
        if (item) {
          item.state = "completed";
          return `Completed: [${item.id}] ${item.description}`;
        }
        return `No todo with id ${id}.`;
      }

      return (
        todos
          .map((item) => `[${item.state}] ${item.id}: ${item.description}`)
          .join("\n") || "No todos."
      );
    },
  });
}

export function createLoadSkillTool(skills: Skill[]) {
  const MAX_SKILL_CHARS = 4_000;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return tool({
    description: `Load the full content of a skill.
WHEN TO USE: the task touches a domain covered by an available skill.
WHEN NOT TO USE: tasks unrelated to the listed skills.
DO NOT USE FOR: names not listed in the Skills section.`,
    inputSchema: z.object({
      name: z.string().describe("Skill name as listed in the Skills section"),
    }),
    execute: async ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        return `Unknown skill: ${name}`;
      }

      const content = readFileSync(skill.path, "utf-8");
      return content.length > MAX_SKILL_CHARS
        ? content.slice(0, MAX_SKILL_CHARS) +
            `\n... (truncated at ${MAX_SKILL_CHARS} chars)`
        : content;
    },
  });
}

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
 
type TaskParentTools = { read: any; grep: any; executorBash: any };

function buildExplorer(sandbox: Sandbox, parentTools: TaskParentTools) {
  return new ToolLoopAgent({
    model: groq("openai/gpt-oss-20b"),
    providerOptions: {
      groq: { reasoningEffort: "low" },
    },
    instructions: `You are an explorer agent. Investigate and report back concisely.
Working directory: ${sandbox.workingDirectory}`,
    tools: { read: parentTools.read, grep: parentTools.grep },
    stopWhen: stepCountIs(5),
  });
}

function buildExecutor(sandbox: Sandbox, parentTools: TaskParentTools) {
  return new ToolLoopAgent({
    model: groq("openai/gpt-oss-120b"),
    providerOptions: {
      groq: { reasoningEffort: "low" },
    },
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
}

async function runSubagent(
  role: "explorer" | "executor",
  agent: ToolLoopAgent<never, any, any, any>,
  description: string,
) {
  const label = role === "explorer" ? "Explorer" : "Executor";

  try {
    const { text, steps } = await agent.generate({ prompt: description });
    return text
      ? `[${label}: ${steps.length} steps]\n${text}`
      : `(no response from ${role})`;
  } catch (e: any) {
    return `${label} error: ${e.message}`;
  }
}

export function createTaskTool(
  sandbox: Sandbox,
  parentTools: TaskParentTools,
) {
  return tool({
    description: `Delegate work to a subagent.
Explorer (default): read-only research with a fast Groq model. Use for searching
across files, understanding patterns, and gathering context.
Executor: implementation with a stronger Groq model and delegated Bash. Use for
focused changes with explicit instructions and a known verification step.

WHEN TO USE: research across many files (explorer), focused implementation (executor).
WHEN NOT TO USE: ambiguous requirements (use askUser), architectural decisions
(the parent decides), or single-step tasks the parent can do directly.`,
    inputSchema: z.object({
      description: z.string().describe("Task instructions for the subagent"),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Subagent role"),
    }),
    execute: async ({ description, subagentType }) => {
      const agent =
        subagentType === "executor"
          ? buildExecutor(sandbox, parentTools)
          : buildExplorer(sandbox, parentTools);
      return runSubagent(subagentType, agent, description);
    },
  });
}