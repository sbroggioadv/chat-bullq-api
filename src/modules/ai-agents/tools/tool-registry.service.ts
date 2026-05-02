import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiTool, toLlmDefinition } from './tool.types';
import { LlmToolDefinition } from '../llm/llm.types';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';

/**
 * Central catalog of every tool available to AI agents. New tools are
 * registered here at startup; agents can opt-in/out via configuration
 * (Sprint 2 will add per-agent tool whitelists). For MVP, every agent
 * gets the full default tool set below.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, AiTool>();

  constructor(
    reply: ReplyToConversationTool,
    transfer: TransferToHumanTool,
    tag: TagConversationTool,
  ) {
    this.register(reply);
    this.register(transfer);
    this.register(tag);
    this.logger.log(
      `Registered ${this.tools.size} built-in tools: ${[...this.tools.keys()].join(', ')}`,
    );
  }

  private register(tool: AiTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AiTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new NotFoundException(`Unknown tool: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Returns LLM-format tool definitions for the default tool set. */
  getDefaultLlmDefinitions(): LlmToolDefinition[] {
    return [...this.tools.values()].map(toLlmDefinition);
  }

  /** Returns LLM-format tool definitions for a specific subset, by name. */
  getLlmDefinitions(names: string[]): LlmToolDefinition[] {
    return names
      .filter((n) => this.tools.has(n))
      .map((n) => toLlmDefinition(this.tools.get(n)!));
  }
}
