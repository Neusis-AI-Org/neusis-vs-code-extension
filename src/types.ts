// ─── Claude Code CLI NDJSON Protocol Types ───

/** Top-level discriminated union for all messages from Claude Code CLI */
export type ClaudeMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeStreamEvent
  | ClaudeResultMessage;

// ─── System ───

export interface ClaudeSystemMessage {
  type: 'system';
  subtype: 'init' | 'compact_boundary';
  uuid: string;
  session_id: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  slash_commands?: string[];
  output_style?: string;
  compact_metadata?: { trigger: string; pre_tokens: number };
}

// ─── Assistant ───

export interface ClaudeAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AssistantContentBlock[];
    model?: string;
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
    usage?: TokenUsage;
  };
}

export type AssistantContentBlock = TextBlock | ToolUseBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ─── User (tool results) ───

export interface ClaudeUserMessage {
  type: 'user';
  uuid: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: 'user';
    content: ToolResultBlock[];
  };
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ─── Stream Events (token-level) ───

export interface ClaudeStreamEvent {
  type: 'stream_event';
  uuid: string;
  session_id: string;
  parent_tool_use_id: string | null;
  event: StreamEventPayload;
}

export type StreamEventPayload =
  | { type: 'message_start'; message: { id: string; type: string; role: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> } }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage?: { output_tokens: number } }
  | { type: 'message_stop' };

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

// ─── Result ───

export interface ClaudeResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result?: string;
  errors?: string[];
  total_cost_usd: number;
  usage?: TokenUsage;
}

// ─── Shared ───

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Input message (sent to Claude via stdin) ───

export interface ClaudeInputMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<{ type: string; text?: string; source?: unknown }>;
  };
  session_id: string;
  parent_tool_use_id: null;
}

// ─── Webview messaging ───

/** Permission mode identifiers */
export type PermissionMode = 'askFirst' | 'autoEdit' | 'planFirst';

/** Messages sent from extension to webview */
export type ExtensionToWebviewMessage =
  | { type: 'streamText'; text: string }
  | { type: 'assistantMessage'; content: AssistantContentBlock[] }
  | { type: 'toolResult'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'toolUseStart'; id: string; name: string }
  | { type: 'resultMessage'; result: string; cost: number; duration: number; isError: boolean }
  | { type: 'sessionInit'; model: string; tools: string[]; sessionId: string }
  | { type: 'stateChange'; state: 'idle' | 'waiting' | 'streaming' | 'error' }
  | { type: 'errorMessage'; message: string }
  | { type: 'approvalRequest'; requestId: string; toolName: string; detail: string }
  | { type: 'modeSync'; mode: PermissionMode }
  | { type: 'clear' };

/** Messages sent from webview to extension */
export type WebviewToExtensionMessage =
  | { type: 'sendMessage'; text: string }
  | { type: 'stopGeneration' }
  | { type: 'modeChange'; mode: PermissionMode }
  | { type: 'approvalResponse'; requestId: string; approved: boolean }
  | { type: 'newChat' };
