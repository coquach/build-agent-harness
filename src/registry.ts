import { tool, type Tool } from "ai";
import type { Sandbox } from "./sanbox";
import type { Skill } from "./skills";
import {
  createAskUserTool,
  createBashTool,
  createGrepTool,
  createLoadSkillTool,
  createReadTool,
  createTaskTool,
  createTodoTool,
} from "./tools";

export interface ToolRegistry {
  register(name: string, tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): string[];
  entries(): [string, Tool][];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register: (name, registeredTool) => {
      tools.set(name, registeredTool);
    },
    get: (name) => tools.get(name),
    list: () => [...tools.keys()],
    entries: () => [...tools.entries()],
  };
}

interface BuiltinOptions {
  requiresApproval: (input: { command: string }) => boolean;
  executorRequiresApproval: (input: { command: string }) => boolean;
}

export function registerBuiltins(
  registry: ToolRegistry,
  sandbox: Sandbox,
  skills: Skill[],
  options: BuiltinOptions,
) {
  registry.register("read", createReadTool(sandbox));
  registry.register("grep", createGrepTool(sandbox));
  registry.register(
    "bash",
    createBashTool(sandbox, options.requiresApproval),
  );
  registry.register(
    "task",
    createTaskTool(sandbox, {
      read: registry.get("read")!,
      grep: registry.get("grep")!,
      executorBash: createBashTool(sandbox, options.executorRequiresApproval),
    }),
  );
  registry.register("askUser", createAskUserTool());
  registry.register("todo", createTodoTool());
  registry.register("loadSkill", createLoadSkillTool(skills));
}

interface WrapHooks {
  beforeExecute?: (input: any) => any | Promise<any>;
  afterExecute?: (result: any) => any | Promise<any>;
}

export function wrapTool(base: Tool, hooks: WrapHooks): Tool {
  return tool({
    description: base.description,
    inputSchema: base.inputSchema,
    execute: async (input, options) => {
      if (!base.execute) {
        throw new Error("wrapTool needs a tool with an execute function");
      }

      const transformed = hooks.beforeExecute
        ? await hooks.beforeExecute(input)
        : input;
      const result = await base.execute(transformed, options);
      return hooks.afterExecute ? hooks.afterExecute(result) : result;
    },
  });
}
