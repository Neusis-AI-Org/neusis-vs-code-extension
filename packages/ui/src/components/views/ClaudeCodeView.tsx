import React, { useState, useRef, useEffect, useCallback } from 'react';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { getToolIcon } from '@/components/chat/message/parts/ToolPart';
import { RiArrowDownSLine, RiErrorWarningLine, RiTerminalBoxLine } from '@remixicon/react';
import { cn } from '@/lib/utils';

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

// ---------------------------------------------------------------------------
// ClaudeCodeToolUse — collapsible tool display
// ---------------------------------------------------------------------------

const ClaudeCodeToolUse: React.FC<{ tool: ClaudeCodeToolBlock }> = ({ tool }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-1.5 rounded-md border border-[var(--tools-border,var(--border))] overflow-hidden">
      <button
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs hover:bg-interactive-hover transition-colors text-left"
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <span className="text-[var(--tools-icon,var(--muted-foreground))]">
          {getToolIcon(tool.name)}
        </span>
        <span className="text-[var(--tools-title,var(--foreground))] font-medium truncate">
          {tool.name}
        </span>
        {tool.isStreaming && (
          <span className="text-muted-foreground animate-pulse">...</span>
        )}
        {tool.error && (
          <span className="text-[var(--status-error)] text-[10px] ml-auto mr-1">error</span>
        )}
        <RiArrowDownSLine
          className={cn(
            'h-3 w-3 ml-auto flex-shrink-0 text-muted-foreground transition-transform',
            !isExpanded && '-rotate-90',
          )}
        />
      </button>
      {isExpanded && (
        <div className="px-2 py-1.5 border-t border-[var(--tools-border,var(--border))] text-xs space-y-1.5">
          {Object.keys(tool.input).length > 0 && (
            <pre className="whitespace-pre-wrap break-words text-muted-foreground overflow-x-auto max-h-40 overflow-y-auto">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
          {tool.result && (
            <div className="pt-1 border-t border-[var(--tools-border,var(--border))]">
              <pre className="whitespace-pre-wrap break-words text-muted-foreground overflow-x-auto max-h-40 overflow-y-auto">
                {tool.result}
              </pre>
            </div>
          )}
          {tool.error && (
            <div
              className="p-1.5 rounded text-xs border"
              style={{
                backgroundColor: 'var(--status-error-background, transparent)',
                color: 'var(--status-error)',
                borderColor: 'var(--status-error-border, var(--status-error))',
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
        backgroundColor: 'var(--status-error-background, transparent)',
        borderColor: 'var(--status-error-border, var(--status-error))',
      }}
    >
      <div className="flex items-center gap-2 text-[var(--status-error)]">
        {icon}
        <span className="font-medium">{ERROR_TITLES[error.kind]}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--status-error)] opacity-80 break-words">
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
// Main view
// ---------------------------------------------------------------------------

export const ClaudeCodeView: React.FC = () => {
  const [messages, setMessages] = useState<ClaudeCodeMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<ClaudeCodeError | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);

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
        messages?: ClaudeCodePersistedMessage[];
      };
      if (!msg?.type) return;

      switch (msg.type) {
        case 'claude:availability': {
          setIsAvailable(msg.available ?? false);
          setVersion(msg.version ?? null);
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

                  // Check if we need to preserve existing tool blocks that might be missing from the summary
                  const existingTools = last.content.filter(b => b.type === 'tool_use');
                  const newHasTools = newBlocks.some(b => b.type === 'tool_use');

                  let mergedContent = newBlocks;
                  
                  // If the new message is just text (summary) but we had tools, preserve the tools
                  // and append the new text (or replace the text parts).
                  if (existingTools.length > 0 && !newHasTools) {
                    // Filter out old text, keep tools
                    const justTools = last.content.filter(b => b.type === 'tool_use');
                    // Append the new content (which is likely just text)
                    mergedContent = [...justTools, ...newBlocks];
                  }

                  return [
                    ...withAssistant.slice(0, -1),
                    { role: 'assistant' as const, content: mergedContent },
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

  const handleQuickResponse = useCallback((response: string) => {
    if (isStreaming) return;
    setMessages(prev => [...prev, { role: 'user', content: [{ type: 'text', text: response }] }]);
    setInput('');
    setError(null);
    setIsStreaming(true);
    streamTextBufferRef.current = '';
    toolInputBuffersRef.current.clear();
    getVSCodeApi()?.postMessage({ type: 'claude:send', payload: { prompt: response } });
  }, [isStreaming]);

  // Check if the last assistant message ended with a permission-like question
  const isWaitingForPermission = useMemo(() => {
    if (isStreaming || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant') return false;
    
    // Check text content for question patterns
    const text = getTextFromMessage(lastMsg).trim().toLowerCase();
    const questionPatterns = [
      '(y/n)',
      'allow this',
      'do you want to run',
      'proceed with these changes',
      'apply these changes',
      'continue?',
      'press enter',
    ];
    return questionPatterns.some(p => text.includes(p));
  }, [messages, isStreaming]);

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
          {version && (
            <span className="text-xs text-muted-foreground">{version}</span>
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
            <span className="text-xs text-muted-foreground px-1">
              {msg.role === 'user' ? 'You' : 'Neusis'}
            </span>

            {msg.role === 'user' ? (
              <div className="rounded-lg px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap break-words bg-interactive-selection text-foreground">
                {getTextFromMessage(msg)}
              </div>
            ) : (
              <div className="rounded-lg px-3 py-2 text-sm max-w-[90%] break-words bg-interactive-hover text-foreground">
                {msg.content.map((block, blockIdx) =>
                  block.type === 'text' ? (
                    <SimpleMarkdownRenderer key={blockIdx} content={block.text} />
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

      {/* Input */}
      <div className="border-t border-border/60 px-3 py-2 flex flex-col gap-2">
        {isWaitingForPermission && (
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => handleQuickResponse('y')}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-600/20 text-green-500 border border-green-600/30 hover:bg-green-600/30 transition-colors"
            >
              Yes (y)
            </button>
            <button
              onClick={() => handleQuickResponse('n')}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600/20 text-red-500 border border-red-600/30 hover:bg-red-600/30 transition-colors"
            >
              No (n)
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={isWaitingForPermission ? "Type 'y' or 'n' or instructions..." : "Message Neusis Code..."}
            rows={2}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
          />
          <div className="flex flex-col gap-1">
            {isStreaming ? (
              <button
                className="px-3 py-2 rounded-md text-sm bg-interactive-hover text-foreground hover:bg-interactive-selection transition-colors"
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
