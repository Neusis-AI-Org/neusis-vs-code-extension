import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { getToolIcon } from '@/components/chat/message/parts/ToolPart';
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiQuestionLine,
  RiShieldCheckLine,
  RiTerminalBoxLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface ClaudeModel {
  id: string;
  label: string;
  shortLabel: string;
}

const CLAUDE_MODELS: ClaudeModel[] = [
  { id: '', label: 'CLI Default', shortLabel: 'Default' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', shortLabel: 'Sonnet 4.5' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', shortLabel: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', shortLabel: 'Haiku 4.5' },
];

const getModelLabel = (modelId: string): string => {
  return CLAUDE_MODELS.find(m => m.id === modelId)?.shortLabel ?? modelId;
};

// ---------------------------------------------------------------------------
// Permission mode definitions
// ---------------------------------------------------------------------------

interface PermissionModeOption {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
}

const PERMISSION_MODES: PermissionModeOption[] = [
  { id: 'acceptEdits', label: 'Accept Edits', shortLabel: 'Edits', description: 'Auto-approve file operations' },
  { id: 'plan', label: 'Plan Only', shortLabel: 'Plan', description: 'Read-only, no tool execution' },
  { id: 'dontAsk', label: "Don't Ask", shortLabel: "Don't Ask", description: 'Auto-approve all tools' },
  { id: 'default', label: 'Default', shortLabel: 'Ask', description: 'Standard permission prompts' },
  { id: 'bypassPermissions', label: 'Bypass All', shortLabel: 'Bypass', description: 'No safety checks' },
];

const getPermissionModeLabel = (modeId: string): string => {
  return PERMISSION_MODES.find(m => m.id === modeId)?.shortLabel ?? modeId;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeCodeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeCodeToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  isStreaming: boolean;
  result?: string | null;
  error?: string | null;
}

type ClaudeCodeContentBlock = ClaudeCodeTextBlock | ClaudeCodeToolBlock;

interface ClaudeCodeMessage {
  role: 'user' | 'assistant';
  content: ClaudeCodeContentBlock[];
}

type ClaudeCodeErrorKind = 'cli_not_found' | 'process_crashed' | 'process_error' | 'unknown';

interface ClaudeCodeError {
  kind: ClaudeCodeErrorKind;
  message: string;
  recoverable: boolean;
}

interface ClaudeCodeEvent {
  type: string;
  [key: string]: unknown;
}

// Serialisable subset of ClaudeCodeMessage for persistence / restore messages.
export type ClaudeCodePersistedMessage = {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: string | null; error?: string | null }
  >;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getVSCodeApi = (): { postMessage: (msg: unknown) => void } | null => {
  return (window as unknown as { __OPENCHAMBER_VSCODE_API__?: { postMessage: (msg: unknown) => void } }).__OPENCHAMBER_VSCODE_API__ ?? null;
};

const classifyError = (errorMessage: string): ClaudeCodeError => {
  const lower = errorMessage.toLowerCase();
  if (lower.includes('not found') || lower.includes('enoent') || lower.includes('is not recognized')) {
    return { kind: 'cli_not_found', message: errorMessage, recoverable: false };
  }
  if (lower.includes('killed') || lower.includes('sigterm') || lower.includes('exit code')) {
    return { kind: 'process_crashed', message: errorMessage, recoverable: true };
  }
  return { kind: 'process_error', message: errorMessage, recoverable: true };
};

const getTextFromMessage = (msg: ClaudeCodeMessage): string => {
  return msg.content
    .filter((b): b is ClaudeCodeTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
};

/** Ensure the last message is an assistant message, creating one if needed. */
const ensureAssistantMessage = (prev: ClaudeCodeMessage[]): ClaudeCodeMessage[] => {
  const last = prev[prev.length - 1];
  if (last?.role === 'assistant') return prev;
  return [...prev, { role: 'assistant', content: [] }];
};

/** Update the last assistant message's content blocks via a mutator. */
const updateLastAssistantBlocks = (
  prev: ClaudeCodeMessage[],
  updater: (blocks: ClaudeCodeContentBlock[]) => ClaudeCodeContentBlock[],
): ClaudeCodeMessage[] => {
  const withAssistant = ensureAssistantMessage(prev);
  const last = withAssistant[withAssistant.length - 1];
  return [
    ...withAssistant.slice(0, -1),
    { ...last, content: updater([...last.content]) },
  ];
};

/** Get or create the last text block in a content array. */
const getOrCreateLastTextBlock = (blocks: ClaudeCodeContentBlock[]): ClaudeCodeContentBlock[] => {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text') return blocks;
  return [...blocks, { type: 'text', text: '' }];
};

/** Format tool name for display */
const formatToolName = (name: string): string => {
  // Convert snake_case/camelCase to Title Case
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
};

/** Get a short summary of tool input for display */
const getToolSummary = (tool: ClaudeCodeToolBlock): string | null => {
  const input = tool.input;
  if (!input || Object.keys(input).length === 0) return null;

  // Show file path for file operations
  if (input.file_path) return String(input.file_path).split(/[/\\]/).pop() ?? null;
  if (input.path) return String(input.path).split(/[/\\]/).pop() ?? null;
  if (input.pattern) return String(input.pattern);
  if (input.command) {
    const cmd = String(input.command);
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  }
  if (input.query) {
    const q = String(input.query);
    return q.length > 60 ? q.slice(0, 57) + '...' : q;
  }
  if (input.content) return `${String(input.content).length} chars`;
  return null;
};

// ---------------------------------------------------------------------------
// AskUserQuestionCard — interactive question card for AskUserQuestion tool
// ---------------------------------------------------------------------------

const AskUserQuestionCard: React.FC<{
  tool: ClaudeCodeToolBlock;
  onAnswer: (toolUseId: string, answer: string) => void;
  isWaiting: boolean;
}> = ({ tool, onAnswer, isWaiting }) => {
  const [freeText, setFreeText] = useState('');
  const question = typeof tool.input.question === 'string' ? tool.input.question : '';
  const options = Array.isArray(tool.input.options) ? (tool.input.options as string[]) : [];
  const answered = tool.result !== undefined && tool.result !== null;

  return (
    <div className={cn(
      'my-1 rounded-lg border overflow-hidden',
      answered
        ? 'border-[var(--border)] bg-transparent'
        : 'border-blue-500/30 bg-blue-500/5',
    )}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {answered
          ? <RiCheckLine className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
          : <RiQuestionLine className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 animate-pulse" />
        }
        <span className="text-xs font-medium text-foreground flex-1">{question}</span>
      </div>

      {answered ? (
        /* Answered state */
        <div className="px-3 py-1.5 border-t border-[var(--border)]/50 text-xs text-muted-foreground">
          <span className="opacity-60">Answered: </span>
          <span>{tool.result}</span>
        </div>
      ) : options.length > 0 ? (
        /* Option buttons */
        <div className="flex flex-col border-t border-blue-500/20">
          {options.map((opt, i) => (
            <button
              key={i}
              className="w-full px-3 py-2 text-xs text-left hover:bg-blue-500/10 transition-colors border-b border-blue-500/10 last:border-b-0 text-foreground disabled:opacity-40"
              onClick={() => onAnswer(tool.id, opt)}
              disabled={!isWaiting}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        /* Free-text input when no options */
        <div className="flex gap-2 px-3 py-2 border-t border-blue-500/20">
          <input
            className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Type your answer..."
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && freeText.trim()) { onAnswer(tool.id, freeText.trim()); setFreeText(''); } }}
            disabled={!isWaiting}
            autoFocus
          />
          <button
            className="px-2 py-1 rounded text-xs bg-interactive-selection text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40"
            onClick={() => { if (freeText.trim()) { onAnswer(tool.id, freeText.trim()); setFreeText(''); } }}
            disabled={!isWaiting || !freeText.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ClaudeCodeToolUse — collapsible tool display with status indicators
// ---------------------------------------------------------------------------

const ClaudeCodeToolUse: React.FC<{ tool: ClaudeCodeToolBlock }> = ({ tool }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = getToolSummary(tool);

  const statusIcon = tool.isStreaming ? (
    <RiLoader4Line className="h-3 w-3 animate-spin text-blue-400" />
  ) : tool.error ? (
    <RiCloseLine className="h-3 w-3 text-red-400" />
  ) : tool.result !== undefined && tool.result !== null ? (
    <RiCheckLine className="h-3 w-3 text-green-400" />
  ) : (
    <RiCheckLine className="h-3 w-3 text-muted-foreground/50" />
  );

  return (
    <div className={cn(
      'my-1 rounded-md border overflow-hidden transition-colors',
      tool.isStreaming
        ? 'border-blue-500/30 bg-blue-500/5'
        : tool.error
          ? 'border-red-500/20 bg-red-500/5'
          : 'border-[var(--border)] bg-transparent',
    )}>
      <button
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs hover:bg-[var(--interactive-hover)] transition-colors text-left group"
        onClick={() => setIsExpanded(prev => !prev)}
      >
        {statusIcon}
        <span className="text-[var(--tools-icon,var(--muted-foreground))] opacity-70">
          {getToolIcon(tool.name)}
        </span>
        <span className="text-[var(--foreground)] font-medium">
          {formatToolName(tool.name)}
        </span>
        {summary && (
          <span className="text-muted-foreground truncate ml-1 flex-1 min-w-0 opacity-60">
            {summary}
          </span>
        )}
        {tool.isStreaming && !summary && (
          <span className="text-blue-400 text-[10px] ml-1">running</span>
        )}
        <RiArrowDownSLine
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
            !isExpanded && '-rotate-90',
          )}
        />
      </button>
      {isExpanded && (
        <div className="px-2.5 py-2 border-t border-[var(--border)]/50 text-xs space-y-2">
          {Object.keys(tool.input).length > 0 && (
            <pre className="whitespace-pre-wrap break-words text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto rounded bg-[var(--background)] p-2 text-[11px] leading-relaxed">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
          {tool.result && (
            <div className="pt-1">
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">Result</div>
              <pre className="whitespace-pre-wrap break-words text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto rounded bg-[var(--background)] p-2 text-[11px] leading-relaxed">
                {tool.result}
              </pre>
            </div>
          )}
          {tool.error && (
            <div
              className="p-2 rounded text-xs border"
              style={{
                backgroundColor: 'var(--status-error-background, rgba(239,68,68,0.1))',
                color: 'var(--status-error, #ef4444)',
                borderColor: 'var(--status-error-border, rgba(239,68,68,0.3))',
              }}
            >
              {tool.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ClaudeCodeErrorDisplay
// ---------------------------------------------------------------------------

const ERROR_TITLES: Record<ClaudeCodeErrorKind, string> = {
  cli_not_found: 'Claude CLI Not Found',
  process_crashed: 'Process Crashed',
  process_error: 'Error',
  unknown: 'Error',
};

const ClaudeCodeErrorDisplay: React.FC<{
  error: ClaudeCodeError;
  onRetry: () => void;
  onDismiss: () => void;
}> = ({ error, onRetry, onDismiss }) => {
  const icon = error.kind === 'cli_not_found'
    ? <RiTerminalBoxLine className="h-4 w-4" />
    : <RiErrorWarningLine className="h-4 w-4" />;

  return (
    <div
      className="rounded-lg px-3 py-2 text-sm border"
      style={{
        backgroundColor: 'var(--status-error-background, rgba(239,68,68,0.1))',
        borderColor: 'var(--status-error-border, rgba(239,68,68,0.3))',
      }}
    >
      <div className="flex items-center gap-2 text-[var(--status-error,#ef4444)]">
        {icon}
        <span className="font-medium">{ERROR_TITLES[error.kind]}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--status-error,#ef4444)] opacity-80 break-words">
        {error.message}
      </div>
      <div className="flex gap-2 mt-2">
        {error.recoverable && (
          <button
            className="text-xs px-2 py-1 rounded-md bg-interactive-hover text-foreground hover:bg-interactive-selection transition-colors"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        <button
          className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// PermissionDeniedBanner — shown when tools were denied by the CLI
// ---------------------------------------------------------------------------

interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

const PermissionDeniedBanner: React.FC<{
  denials: PermissionDenial[];
  onDismiss: () => void;
}> = ({ denials, onDismiss }) => {
  const toolNames = [...new Set(denials.map(d => d.tool_name))];
  return (
    <div className="mx-3 mb-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <RiShieldCheckLine className="h-4 w-4 text-yellow-500 flex-shrink-0" />
        <span className="text-xs text-foreground font-medium flex-1">
          Permission denied for: {toolNames.join(', ')}
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground border-t border-yellow-500/20">
        The CLI denied tool access. Change <code className="text-foreground/70">openchamber.claudeCode.permissionMode</code> to
        {' '}<code className="text-foreground/70">acceptEdits</code> in VS Code settings to allow file operations.
      </div>
      <div className="flex border-t border-yellow-500/20">
        <button
          onClick={onDismiss}
          className="flex-1 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors flex items-center justify-center gap-1.5"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export const ClaudeCodeView: React.FC = () => {
  const [messages, setMessages] = useState<ClaudeCodeMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<ClaudeCodeError | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<string>('acceptEdits');
  const [isPermissionDropdownOpen, setIsPermissionDropdownOpen] = useState(false);
  const [permissionDenials, setPermissionDenials] = useState<PermissionDenial[]>([]);

  // Refs for streaming state — not in React state to avoid excessive re-renders.
  const streamTextBufferRef = useRef('');
  const toolInputBuffersRef = useRef<Map<string, string>>(new Map());
  const currentToolIndexRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // ------ Message handler ------
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        data?: ClaudeCodeEvent;
        error?: string;
        available?: boolean;
        version?: string;
        model?: string;
        permissionMode?: string;
        messages?: ClaudeCodePersistedMessage[];
      };
      if (!msg?.type) return;

      switch (msg.type) {
        case 'claude:availability': {
          setIsAvailable(msg.available ?? false);
          if (typeof msg.model === 'string') {
            setSelectedModel(msg.model);
          }
          if (typeof msg.permissionMode === 'string') {
            setSelectedPermissionMode(msg.permissionMode);
          }
          break;
        }

        case 'claude:restore': {
          if (msg.messages?.length) {
            // Restore persisted messages — tool blocks get isStreaming=false
            const restored: ClaudeCodeMessage[] = msg.messages.map(m => ({
              role: m.role,
              content: m.content.map(b =>
                b.type === 'tool_use'
                  ? { ...b, isStreaming: false }
                  : b,
              ),
            }));
            setMessages(restored);
          }
          break;
        }

        case 'claude:event': {
          const data = msg.data;
          if (!data) break;

          if (data.type === 'stream_event') {
            const evt = data.event as {
              type?: string;
              index?: number;
              content_block?: { type?: string; id?: string; name?: string };
              delta?: { type?: string; text?: string; partial_json?: string };
            } | undefined;
            if (!evt) break;

            // --- content_block_start: new text or tool_use block ---
            if (evt.type === 'content_block_start' && evt.content_block) {
              if (evt.content_block.type === 'tool_use') {
                const toolId = evt.content_block.id ?? `tool-${Date.now()}`;
                const toolName = evt.content_block.name ?? 'unknown';
                currentToolIndexRef.current = evt.index ?? null;
                toolInputBuffersRef.current.set(toolId, '');
                setMessages(prev =>
                  updateLastAssistantBlocks(prev, blocks => [
                    ...blocks,
                    {
                      type: 'tool_use',
                      id: toolId,
                      name: toolName,
                      input: {},
                      isStreaming: true,
                    },
                  ]),
                );
              }
              break;
            }

            // --- content_block_delta: text or tool input ---
            if (evt.type === 'content_block_delta' && evt.delta) {
              // Text delta
              if (evt.delta.type === 'text_delta' && typeof evt.delta.text === 'string') {
                streamTextBufferRef.current += evt.delta.text;
                const bufferedText = streamTextBufferRef.current;
                setMessages(prev =>
                  updateLastAssistantBlocks(prev, blocks => {
                    const updated = getOrCreateLastTextBlock(blocks);
                    const last = updated[updated.length - 1] as ClaudeCodeTextBlock;
                    return [...updated.slice(0, -1), { ...last, text: bufferedText }];
                  }),
                );
                break;
              }

              // Tool input delta
              if (evt.delta.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
                // Find the last tool_use block to identify it
                setMessages(prev => {
                  const withAssistant = ensureAssistantMessage(prev);
                  const last = withAssistant[withAssistant.length - 1];
                  const toolBlock = [...last.content].reverse().find(
                    (b): b is ClaudeCodeToolBlock => b.type === 'tool_use' && b.isStreaming,
                  );
                  if (toolBlock) {
                    const buf = (toolInputBuffersRef.current.get(toolBlock.id) ?? '') + evt.delta!.partial_json!;
                    toolInputBuffersRef.current.set(toolBlock.id, buf);
                    // Try to parse accumulated JSON
                    try {
                      const parsed = JSON.parse(buf) as Record<string, unknown>;
                      return updateLastAssistantBlocks(prev, blocks =>
                        blocks.map(b =>
                          b.type === 'tool_use' && b.id === toolBlock.id
                            ? { ...b, input: parsed }
                            : b,
                        ),
                      );
                    } catch {
                      // Incomplete JSON, skip update
                    }
                  }
                  return prev;
                });
                break;
              }
              break;
            }

            // --- content_block_stop: finalize tool ---
            if (evt.type === 'content_block_stop') {
              currentToolIndexRef.current = null;
              setMessages(prev =>
                updateLastAssistantBlocks(prev, blocks =>
                  blocks.map(b => {
                    if (b.type !== 'tool_use' || !b.isStreaming) return b;
                    // Try final parse of accumulated input
                    const buf = toolInputBuffersRef.current.get(b.id) ?? '';
                    let input = b.input;
                    try {
                      input = JSON.parse(buf) as Record<string, unknown>;
                    } catch { /* keep partial */ }
                    return { ...b, isStreaming: false, input };
                  }),
                ),
              );
              break;
            }
            break;
          }

          // assistant — complete message (may arrive after stream_events)
          if (data.type === 'assistant') {
            const message = data.message as {
              content?: Array<{
                type?: string;
                text?: string;
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }>;
            } | undefined;
            if (message?.content) {
              const newBlocks: ClaudeCodeContentBlock[] = [];
              for (const c of message.content) {
                if (c.type === 'text' && typeof c.text === 'string') {
                  newBlocks.push({ type: 'text', text: c.text });
                } else if (c.type === 'tool_use' && c.id && c.name) {
                  newBlocks.push({
                    type: 'tool_use',
                    id: c.id,
                    name: c.name,
                    input: c.input ?? {},
                    isStreaming: false,
                  });
                }
              }
              if (newBlocks.length > 0) {
                streamTextBufferRef.current = '';
                setMessages(prev => {
                  const withAssistant = ensureAssistantMessage(prev);
                  const last = withAssistant[withAssistant.length - 1];

                  // Build a map of existing tool blocks (with their results/errors preserved)
                  const existingToolMap = new Map<string, ClaudeCodeToolBlock>();
                  for (const b of last.content) {
                    if (b.type === 'tool_use') {
                      existingToolMap.set(b.id, b);
                    }
                  }

                  const newToolIds = new Set<string>();
                  for (const b of newBlocks) {
                    if (b.type === 'tool_use') newToolIds.add(b.id);
                  }

                  // Merge strategy: keep existing tools that aren't in the new set,
                  // and for tools in both, preserve results/errors from existing
                  const mergedBlocks: ClaudeCodeContentBlock[] = newBlocks.map(b => {
                    if (b.type === 'tool_use' && existingToolMap.has(b.id)) {
                      const existing = existingToolMap.get(b.id)!;
                      return {
                        ...b,
                        result: existing.result ?? b.result,
                        error: existing.error ?? b.error,
                      };
                    }
                    return b;
                  });

                  // Prepend any existing tools that aren't in the new blocks
                  const orphanedTools = [...existingToolMap.values()].filter(
                    t => !newToolIds.has(t.id),
                  );
                  const finalContent = orphanedTools.length > 0
                    ? [...orphanedTools, ...mergedBlocks]
                    : mergedBlocks;

                  return [
                    ...withAssistant.slice(0, -1),
                    { role: 'assistant' as const, content: finalContent },
                  ];
                });
              }
            }
            break;
          }

          // tool_result — match by tool_use_id and populate result
          if (data.type === 'tool_result') {
            const toolUseId = data.tool_use_id as string | undefined;
            const resultContent = data.content as string | Array<{ type?: string; text?: string }> | undefined;
            const isError = data.is_error as boolean | undefined;
            if (toolUseId) {
              let resultText = '';
              if (typeof resultContent === 'string') {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = resultContent
                  .filter(c => c.type === 'text' && typeof c.text === 'string')
                  .map(c => c.text)
                  .join('');
              }
              setMessages(prev =>
                updateLastAssistantBlocks(prev, blocks =>
                  blocks.map(b =>
                    b.type === 'tool_use' && b.id === toolUseId
                      ? {
                          ...b,
                          isStreaming: false,
                          ...(isError ? { error: resultText || 'Tool error' } : { result: resultText }),
                        }
                      : b,
                  ),
                ),
              );
            }
            break;
          }

          // result — final result, check for permission denials
          if (data.type === 'result') {
            const denials = data.permission_denials as PermissionDenial[] | undefined;
            if (denials && denials.length > 0) {
              setPermissionDenials(denials);
            }
          }

          // result — final result with full text
          if (data.type === 'result' && typeof data.result === 'string' && data.result.trim()) {
            streamTextBufferRef.current = data.result as string;
            setMessages(prev =>
              updateLastAssistantBlocks(prev, blocks => {
                const updated = getOrCreateLastTextBlock(blocks);
                const last = updated[updated.length - 1] as ClaudeCodeTextBlock;
                return [...updated.slice(0, -1), { ...last, text: data.result as string }];
              }),
            );
            break;
          }

          // text — plain text fallback (non-JSON CLI output)
          if (data.type === 'text' && typeof data.content === 'string') {
            streamTextBufferRef.current += (data.content as string) + '\n';
            const bufferedText = streamTextBufferRef.current;
            setMessages(prev =>
              updateLastAssistantBlocks(prev, blocks => {
                const updated = getOrCreateLastTextBlock(blocks);
                const last = updated[updated.length - 1] as ClaudeCodeTextBlock;
                return [...updated.slice(0, -1), { ...last, text: bufferedText }];
              }),
            );
            break;
          }

          break;
        }

        case 'claude:done': {
          setIsStreaming(false);
          streamTextBufferRef.current = '';
          toolInputBuffersRef.current.clear();
          currentToolIndexRef.current = null;
          break;
        }

        case 'claude:error': {
          setIsStreaming(false);
          setError(classifyError(msg.error ?? 'Unknown error'));
          streamTextBufferRef.current = '';
          toolInputBuffersRef.current.clear();
          currentToolIndexRef.current = null;
          break;
        }

        case 'claude:aborted': {
          setIsStreaming(false);
          streamTextBufferRef.current = '';
          toolInputBuffersRef.current.clear();
          currentToolIndexRef.current = null;
          break;
        }

        case 'claude:conversationReset': {
          setMessages([]);
          setError(null);
          setIsStreaming(false);
          streamTextBufferRef.current = '';
          toolInputBuffersRef.current.clear();
          currentToolIndexRef.current = null;
          break;
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ------ Actions ------

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || isStreaming) return;

    setMessages(prev => [...prev, { role: 'user', content: [{ type: 'text', text: prompt }] }]);
    setInput('');
    setError(null);
    setPermissionDenials([]);
    setIsStreaming(true);
    streamTextBufferRef.current = '';
    toolInputBuffersRef.current.clear();

    getVSCodeApi()?.postMessage({ type: 'claude:send', payload: { prompt } });
  }, [input, isStreaming]);

  const handleAbort = useCallback(() => {
    getVSCodeApi()?.postMessage({ type: 'claude:abort' });
  }, []);

  const handleNewConversation = useCallback(() => {
    getVSCodeApi()?.postMessage({ type: 'claude:newConversation' });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      const text = getTextFromMessage(lastUserMsg);
      if (text) {
        setError(null);
        setIsStreaming(true);
        streamTextBufferRef.current = '';
        toolInputBuffersRef.current.clear();
        getVSCodeApi()?.postMessage({ type: 'claude:send', payload: { prompt: text } });
      }
    }
  }, [messages]);

  const hasPermissionDenials = permissionDenials.length > 0;

  /**
   * Find the first unanswered AskUserQuestion tool block in the last assistant message
   * while the process is still running (waiting for the tool_result on stdin).
   */
  const pendingAskQuestion = useMemo((): ClaudeCodeToolBlock | null => {
    if (!isStreaming) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      for (const block of msg.content) {
        if (
          block.type === 'tool_use' &&
          block.name === 'AskUserQuestion' &&
          !block.isStreaming &&
          block.result === undefined &&
          block.error === undefined
        ) {
          return block;
        }
      }
      break; // only check the last assistant message
    }
    return null;
  }, [messages, isStreaming]);

  const handleAnswerQuestion = useCallback((toolUseId: string, answer: string) => {
    // Mark the tool block as answered immediately in UI
    setMessages(prev =>
      prev.map(msg => ({
        ...msg,
        content: msg.content.map(block =>
          block.type === 'tool_use' && block.id === toolUseId
            ? { ...block, result: answer }
            : block,
        ),
      })),
    );
    getVSCodeApi()?.postMessage({ type: 'claude:respondToTool', payload: { toolUseId, content: answer } });
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    setIsModelDropdownOpen(false);
    getVSCodeApi()?.postMessage({ type: 'claude:setModel', payload: { model: modelId } });
  }, []);

  const handlePermissionModeChange = useCallback((modeId: string) => {
    setSelectedPermissionMode(modeId);
    setIsPermissionDropdownOpen(false);
    getVSCodeApi()?.postMessage({ type: 'claude:setPermissionMode', payload: { permissionMode: modeId } });
  }, []);

  const handleDismissError = useCallback(() => {
    setError(null);
  }, []);

  // ------ Not available state ------
  if (isAvailable === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 gap-3">
        <div className="text-muted-foreground text-sm text-center">
          Claude Code CLI not found.
        </div>
        <div className="text-muted-foreground text-xs text-center max-w-[280px]">
          Install the Claude Code CLI and ensure it&apos;s in your PATH, or set the path manually in
          VS Code settings (<code className="text-foreground/70">openchamber.claudeCodeBinary</code>).
        </div>
        <button
          className="mt-2 px-3 py-1.5 text-xs rounded-md bg-interactive-hover text-foreground hover:bg-interactive-selection transition-colors"
          onClick={() => getVSCodeApi()?.postMessage({ type: 'claude:checkAvailability' })}
        >
          Retry
        </button>
      </div>
    );
  }

  // ------ Main chat UI ------
  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Neusis Code</span>
          {isStreaming && (
            <RiLoader4Line className="h-3 w-3 animate-spin text-blue-400" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Permission mode selector */}
          <div className="relative">
            <button
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors border border-transparent hover:border-border/60"
              onClick={() => { setIsPermissionDropdownOpen(prev => !prev); setIsModelDropdownOpen(false); }}
              title="Permission mode"
            >
              <RiShieldCheckLine className="h-3 w-3" />
              <span>{getPermissionModeLabel(selectedPermissionMode)}</span>
              <RiArrowDownSLine className={cn(
                'h-3 w-3 transition-transform',
                isPermissionDropdownOpen && 'rotate-180',
              )} />
            </button>
            {isPermissionDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsPermissionDropdownOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[200px] rounded-md border border-border bg-background shadow-lg overflow-hidden">
                  {PERMISSION_MODES.map(mode => (
                    <button
                      key={mode.id}
                      className={cn(
                        'flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-interactive-hover transition-colors',
                        selectedPermissionMode === mode.id && 'bg-interactive-selection text-foreground',
                        selectedPermissionMode !== mode.id && 'text-muted-foreground',
                      )}
                      onClick={() => handlePermissionModeChange(mode.id)}
                    >
                      <div className="flex flex-col gap-0.5">
                        <span>{mode.label}</span>
                        <span className="text-[10px] opacity-60">{mode.description}</span>
                      </div>
                      {selectedPermissionMode === mode.id && (
                        <RiCheckLine className="h-3 w-3 text-green-400 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Model selector */}
          <div className="relative">
            <button
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors border border-transparent hover:border-border/60"
              onClick={() => { setIsModelDropdownOpen(prev => !prev); setIsPermissionDropdownOpen(false); }}
              title="Select model"
            >
              <span>{getModelLabel(selectedModel)}</span>
              <RiArrowDownSLine className={cn(
                'h-3 w-3 transition-transform',
                isModelDropdownOpen && 'rotate-180',
              )} />
            </button>
            {isModelDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsModelDropdownOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-md border border-border bg-background shadow-lg overflow-hidden">
                  {CLAUDE_MODELS.map(model => (
                    <button
                      key={model.id}
                      className={cn(
                        'flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-interactive-hover transition-colors',
                        selectedModel === model.id && 'bg-interactive-selection text-foreground',
                        selectedModel !== model.id && 'text-muted-foreground',
                      )}
                      onClick={() => handleModelChange(model.id)}
                    >
                      <span>{model.label}</span>
                      {selectedModel === model.id && (
                        <RiCheckLine className="h-3 w-3 text-green-400" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {messages.length > 0 && (
            <button
              className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
              onClick={handleNewConversation}
              title="New conversation"
            >
              New
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && !isStreaming && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground text-sm text-center">
              Ask Neusis Code anything about your codebase.
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <span className="text-[10px] text-muted-foreground/60 px-1 uppercase tracking-wider">
              {msg.role === 'user' ? 'You' : 'Neusis'}
            </span>

            {msg.role === 'user' ? (
              <div className="rounded-lg px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap break-words bg-interactive-selection text-foreground">
                {getTextFromMessage(msg)}
              </div>
            ) : (
              <div className="w-full text-sm break-words text-foreground">
                {msg.content.map((block, blockIdx) =>
                  block.type === 'text' ? (
                    <SimpleMarkdownRenderer key={blockIdx} content={block.text} />
                  ) : block.name === 'AskUserQuestion' ? (
                    <AskUserQuestionCard
                      key={block.id}
                      tool={block}
                      onAnswer={handleAnswerQuestion}
                      isWaiting={pendingAskQuestion?.id === block.id}
                    />
                  ) : (
                    <ClaudeCodeToolUse key={block.id} tool={block} />
                  ),
                )}
              </div>
            )}
          </div>
        ))}

        {error && (
          <ClaudeCodeErrorDisplay
            error={error}
            onRetry={handleRetry}
            onDismiss={handleDismissError}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Permission denied banner */}
      {hasPermissionDenials && (
        <PermissionDeniedBanner
          denials={permissionDenials}
          onDismiss={() => setPermissionDenials([])}
        />
      )}

      {/* Input */}
      <div className="border-t border-border/60 px-3 py-2">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Message Neusis Code..."
            rows={2}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
          />
          <div className="flex flex-col gap-1">
            {isStreaming ? (
              <button
                className="px-3 py-2 rounded-md text-sm bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                onClick={handleAbort}
                title="Stop"
              >
                Stop
              </button>
            ) : (
              <button
                className="px-3 py-2 rounded-md text-sm bg-interactive-selection text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40"
                onClick={handleSend}
                disabled={!input.trim()}
                title="Send"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
