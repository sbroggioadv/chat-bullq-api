import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiAgentKind } from '@prisma/client';
import { AiTool as BuiltInSkillImpl, toLlmDefinition } from './tool.types';
import { LlmToolDefinition } from '../llm/llm.types';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ListAvailableAgentsTool } from './builtin/list-available-agents.tool';
import { DelegateToAgentTool } from './builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './builtin/hand-back-to-orchestrator.tool';

/**
 * Registry of BUILT-IN skills (named "tools" in the code for legacy reasons).
 * These are TypeScript functions baked into the platform — they don't have
 * a row in ai_skills/ai_tools because they're always available to every
 * agent of the right kind. Custom skills (HTTP/SQL) live in the database
 * and are resolved at runtime via AiAgentSkill.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, BuiltInSkillImpl>();
  private readonly scope = new Map<string, Set<AiAgentKind>>();

  constructor(
    reply: ReplyToConversationTool,
    transfer: TransferToHumanTool,
    tag: TagConversationTool,
    listAgents: ListAvailableAgentsTool,
    delegate: DelegateToAgentTool,
    handBack: HandBackToOrchestratorTool,
  ) {
    this.register(reply, ['ORCHESTRATOR', 'WORKER']);
    this.register(transfer, ['ORCHESTRATOR', 'WORKER']);
    this.register(tag, ['ORCHESTRATOR', 'WORKER']);
    this.register(listAgents, ['ORCHESTRATOR']);
    this.register(delegate, ['ORCHESTRATOR']);
    this.register(handBack, ['WORKER']);

    this.logger.log(
      `Built-in skills loaded: ${[...this.tools.keys()].join(', ')}`,
    );
  }

  private register(tool: BuiltInSkillImpl, kinds: AiAgentKind[]): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate built-in skill: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.scope.set(tool.name, new Set(kinds));
  }

  get(name: string): BuiltInSkillImpl {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new NotFoundException(`Unknown built-in skill: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Built-in LLM defs filtered by agent kind — always included automatically. */
  getLlmDefinitionsForKind(kind: AiAgentKind): LlmToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.scope.get(t.name)?.has(kind) ?? false)
      .map(toLlmDefinition);
  }

  isAllowedForKind(toolName: string, kind: AiAgentKind): boolean {
    return this.scope.get(toolName)?.has(kind) ?? false;
  }
}
