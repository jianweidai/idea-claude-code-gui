/**
 * Cursor CLI Message Service
 *
 * Runs cursor-agent in headless mode and maps stream-json output
 * into Claude-compatible [MESSAGE] events for the frontend.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const MAX_TOOL_RESULT_CHARS = 20000;

const TOOL_NAME_MAP = {
  lsToolCall: 'glob',
  readToolCall: 'read',
  writeToolCall: 'write',
  editToolCall: 'edit',
  bashToolCall: 'bash',
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const pickNumber = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = toNumber(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const normalizeUsage = (rawUsage) => {
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const inputTokens =
    pickNumber(rawUsage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']) ?? 0;
  const outputTokens =
    pickNumber(rawUsage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']) ?? 0;
  const cacheReadTokens =
    pickNumber(rawUsage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens']) ?? 0;
  const cacheCreationTokens =
    pickNumber(rawUsage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? 0;

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    const totalTokens = pickNumber(rawUsage, ['total_tokens', 'totalTokens']);
    if (typeof totalTokens === 'number' && totalTokens > 0) {
      return {
        input_tokens: totalTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
    }
    return null;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
  };
};

const extractUsageFromEvent = (event) => {
  if (!event || typeof event !== 'object') return null;
  if (event.usage && typeof event.usage === 'object') {
    const normalized = normalizeUsage(event.usage);
    if (normalized) return normalized;
  }
  if (event.result && typeof event.result === 'object' && event.result.usage && typeof event.result.usage === 'object') {
    const normalized = normalizeUsage(event.result.usage);
    if (normalized) return normalized;
  }
  if (event.total_token_usage && typeof event.total_token_usage === 'object') {
    const normalized = normalizeUsage(event.total_token_usage);
    if (normalized) return normalized;
  }
  if (
    event.payload &&
    typeof event.payload === 'object' &&
    event.payload.info &&
    typeof event.payload.info === 'object' &&
    event.payload.info.total_token_usage &&
    typeof event.payload.info.total_token_usage === 'object'
  ) {
    const normalized = normalizeUsage(event.payload.info.total_token_usage);
    if (normalized) return normalized;
  }
  return null;
};

const logCursorDiag = (stage, payload = {}) => {
  try {
    console.log('[CURSOR_DIAG]', JSON.stringify({ stage, ...payload }));
  } catch {
    console.log('[CURSOR_DIAG]', String(stage));
  }
};

const truncateForDisplay = (text, maxChars) => {
  if (typeof text !== 'string') {
    return String(text ?? '');
  }
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const head = Math.max(0, Math.floor(maxChars * 0.65));
  const tail = Math.max(0, maxChars - head);
  const prefix = text.slice(0, head);
  const suffix = tail > 0 ? text.slice(Math.max(0, text.length - tail)) : '';
  return `${prefix}\n...\n(truncated, original length: ${text.length} chars)\n...\n${suffix}`;
};

const extractToolCallPayload = (toolCall) => {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const entries = Object.entries(toolCall);
  if (entries.length === 0) return null;
  const [key, value] = entries[0];
  return { key, value: value || {} };
};

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const buildToolFingerprint = (toolKey, toolData) => {
  const args = toolData?.args ?? {};
  return `${toolKey}:${stableStringify(args)}`;
};

const buildToolUseInput = (toolKey, toolData, originalContent) => {
  const args = toolData?.args ?? {};
  const base = Object.keys(args).length > 0 ? { ...args } : { tool: toolKey };
  if (typeof originalContent === 'string') {
    base.originalContent = originalContent;
  }
  return base;
};

const extractToolPath = (toolData) => {
  const args = toolData?.args;
  if (!args || typeof args !== 'object') return '';
  const candidates = [
    args.path,
    args.filePath,
    args.file_path,
    args.targetFile,
    args.target_file,
    args.file,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
};

const captureOriginalContentSnapshot = async (toolName, toolData) => {
  const normalized = String(toolName || '').toLowerCase();
  if (normalized !== 'edit' && normalized !== 'write') {
    return null;
  }
  const toolPath = extractToolPath(toolData);
  if (!toolPath) return null;
  try {
    const content = await fs.readFile(toolPath, 'utf8');
    return content;
  } catch {
    return '';
  }
};

const extractToolResult = (toolData) => {
  if (!toolData || typeof toolData !== 'object') return { content: '(no output)', isError: false };
  const result = toolData.result ?? toolData.output ?? null;
  const error = toolData.error ?? result?.error ?? null;
  const isError = !!error || result?.success === false;

  if (typeof result === 'string') {
    return { content: result, isError };
  }

  if (result?.success?.content && typeof result.success.content === 'string') {
    return { content: result.success.content, isError };
  }

  if (error) {
    const errorMsg = typeof error === 'string' ? error : error.message || JSON.stringify(error);
    return { content: errorMsg, isError: true };
  }

  if (result) {
    return { content: JSON.stringify(result, null, 2), isError };
  }

  return { content: '(no output)', isError };
};

export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  permissionMode = '',
  cursorMode = '',
  attachments = []
) {
  console.log('[MESSAGE_START]');
  logCursorDiag('send.start', {
    hasSessionId: Boolean(sessionId && sessionId.trim()),
    hasCwd: Boolean(cwd && cwd.trim()),
    model: model || '',
    permissionMode: permissionMode || '',
    cursorMode: cursorMode || '',
    promptLength: typeof message === 'string' ? message.length : 0,
  });
  let latestUsage = null;
  const tempImageFiles = [];
  let effectiveMessage = typeof message === 'string' ? message : '';
  const preparedAttachments = await prepareImageAttachments(attachments, tempImageFiles);
  if (preparedAttachments.promptSuffix) {
    effectiveMessage = `${effectiveMessage}\n\n${preparedAttachments.promptSuffix}`.trim();
  }
  logCursorDiag('attachments.prepared', {
    received: Array.isArray(attachments) ? attachments.length : 0,
    prepared: preparedAttachments.count,
  });

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--force',
  ];

  // IDE 插件场景是无交互的 headless 调用。未显式开启自动批准时，
  // MCP 工具调用会被默认拒绝（日志中表现为 "User rejected MCP"）。
  // 默认开启自动批准，可通过 CURSOR_AUTO_APPROVE_MCPS=false 关闭。
  const autoApproveMcps = process.env.CURSOR_AUTO_APPROVE_MCPS !== 'false';
  if (autoApproveMcps) {
    args.push('--approve-mcps');
  }

  if (cwd && cwd.trim()) {
    args.push('--workspace', cwd.trim());
  }
  if (model && model.trim()) {
    args.push('--model', model.trim());
  }
  if (cursorMode && cursorMode.trim() && cursorMode !== 'default') {
    args.push('--mode', cursorMode.trim());
  }
  if (sessionId && sessionId.trim()) {
    args.push('--resume', sessionId.trim());
  }
  if (effectiveMessage) {
    args.push(effectiveMessage);
  }
  logCursorDiag('send.args', { args: args.slice(0, -1), hasPrompt: Boolean(effectiveMessage) });

  const emitMessage = (payload) => {
    console.log('[MESSAGE]', JSON.stringify(payload));
  };

  const emittedToolUseIds = new Set();
  const pendingToolUseIdsByFingerprint = new Map();
  const originalContentByToolUseId = new Map();
  let assistantTextSeen = false;
  const thinkingChunks = [];
  let thinkingMessageEmitted = false;

  const emitThinkingOnceIfNeeded = () => {
    if (thinkingMessageEmitted) return;
    if (thinkingChunks.length === 0) return;
    // Cursor thinking events are streamed as small deltas; concatenating with '\n'
    // breaks normal sentences into many short lines.
    const mergedThinking = thinkingChunks.join('').trim();
    if (!mergedThinking) return;

    emitMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: mergedThinking, text: mergedThinking }],
      },
    });
    thinkingMessageEmitted = true;
    logCursorDiag('thinking.emitted_once', { chunkCount: thinkingChunks.length, length: mergedThinking.length });
  };

  return new Promise((resolve, reject) => {
    const child = spawn('cursor-agent', args, {
      cwd: cwd && cwd.trim() ? cwd.trim() : process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('error', (err) => {
      cleanupTempImageFiles(tempImageFiles).catch(() => {});
      const errorPayload = {
        success: false,
        error: `Cursor CLI failed to start: ${err.message}`,
      };
      console.log('[SEND_ERROR]', JSON.stringify(errorPayload));
      reject(err);
    });

    const rl = createInterface({ input: child.stdout });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      const usage = extractUsageFromEvent(event);
      if (usage) {
        latestUsage = usage;
        logCursorDiag('usage.extracted', { usage });
        emitMessage({
          type: 'result',
          usage,
        });
      } else if (event && typeof event === 'object') {
        const keys = Object.keys(event);
        const hasTokenLikeKey = keys.some((k) => k.toLowerCase().includes('token')) ||
          JSON.stringify(event).toLowerCase().includes('token');
        if (hasTokenLikeKey) {
          logCursorDiag('usage.candidate_unparsed', {
            type: event.type || '',
            subtype: event.subtype || '',
            keys,
          });
        }
      }

      if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id) {
          console.log('[SESSION_ID]', event.session_id);
        }
        return;
      }

      if (event.type === 'assistant') {
        if (event.model_call_id) {
          return;
        }
        emitThinkingOnceIfNeeded();
        const contentBlocks = event.message?.content || [];
        logCursorDiag('assistant.blocks', {
          count: Array.isArray(contentBlocks) ? contentBlocks.length : 0,
          blockTypes: Array.isArray(contentBlocks) ? contentBlocks.map((b) => b?.type).filter(Boolean) : [],
        });
        for (const block of contentBlocks) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            assistantTextSeen = true;
            emitMessage({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: block.text }],
              },
            });
          }
        }
        return;
      }

      if (event.type === 'thinking') {
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        if (!text) return;
        thinkingChunks.push(text);
        return;
      }

      if (event.type === 'tool_call') {
        const callId = event.call_id || event.tool_call?.id || event.tool_call_id;
        const toolPayload = extractToolCallPayload(event.tool_call);
        if (!toolPayload) return;
        const toolName = TOOL_NAME_MAP[toolPayload.key] || toolPayload.key;
        const explicitToolUseId = callId || toolPayload.value?.args?.toolCallId;
        const toolFingerprint = buildToolFingerprint(toolPayload.key, toolPayload.value);
        let toolUseId = explicitToolUseId || `${toolName}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
        logCursorDiag('tool_call', {
          subtype: event.subtype || '',
          toolKey: toolPayload.key,
          toolName,
          toolUseId,
          explicitToolUseId: explicitToolUseId || '',
          toolFingerprint,
          hasArgs: Boolean(toolPayload.value?.args),
          argKeys: toolPayload.value?.args && typeof toolPayload.value.args === 'object'
            ? Object.keys(toolPayload.value.args)
            : [],
        });

        if (event.subtype === 'started') {
          let originalContent = null;
          try {
            originalContent = await captureOriginalContentSnapshot(toolName, toolPayload.value);
          } catch {
            originalContent = null;
          }
          if (typeof originalContent === 'string') {
            originalContentByToolUseId.set(toolUseId, originalContent);
          }
          const queue = pendingToolUseIdsByFingerprint.get(toolFingerprint) || [];
          queue.push(toolUseId);
          pendingToolUseIdsByFingerprint.set(toolFingerprint, queue);
          logCursorDiag('tool_call.started', {
            toolUseId,
            toolFingerprint,
            pendingForFingerprint: queue.length,
          });

          emitMessage({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: toolUseId,
                  name: toolName,
                  input: buildToolUseInput(
                    toolPayload.key,
                    toolPayload.value,
                    originalContentByToolUseId.get(toolUseId)
                  ),
                },
              ],
            },
          });
          emittedToolUseIds.add(toolUseId);
          return;
        }

        if (event.subtype === 'completed') {
          if (!explicitToolUseId) {
            const queue = pendingToolUseIdsByFingerprint.get(toolFingerprint) || [];
            if (queue.length > 0) {
              toolUseId = queue.shift();
              if (queue.length > 0) {
                pendingToolUseIdsByFingerprint.set(toolFingerprint, queue);
              } else {
                pendingToolUseIdsByFingerprint.delete(toolFingerprint);
              }
            }
          }

          logCursorDiag('tool_call.completed', {
            toolUseId,
            toolFingerprint,
            usedPendingMatch: !explicitToolUseId,
          });

          if (!emittedToolUseIds.has(toolUseId)) {
            emitMessage({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: buildToolUseInput(
                      toolPayload.key,
                      toolPayload.value,
                      originalContentByToolUseId.get(toolUseId)
                    ),
                  },
                ],
              },
            });
            emittedToolUseIds.add(toolUseId);
          }

          const { content, isError } = extractToolResult(toolPayload.value);
          emitMessage({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  is_error: isError,
                  content: truncateForDisplay(content, MAX_TOOL_RESULT_CHARS),
                },
              ],
            },
          });
        }
        return;
      }

      if (event.type === 'result' && !assistantTextSeen) {
        const resultText = typeof event.result === 'string' ? event.result : '';
        if (resultText.trim()) {
          emitMessage({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: resultText }],
            },
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.error('[CURSOR_STDERR]', msg);
      }
    });

    child.on('close', (code) => {
      cleanupTempImageFiles(tempImageFiles).catch(() => {});
      emitThinkingOnceIfNeeded();
      if (latestUsage) {
        logCursorDiag('usage.flush_on_close', { usage: latestUsage });
        emitMessage({
          type: 'result',
          usage: latestUsage,
        });
      }
      logCursorDiag('send.close', { exitCode: code, assistantTextSeen });
      console.log('[MESSAGE_END]');
      if (code !== 0) {
        const errorPayload = {
          success: false,
          error: `Cursor CLI exited with code ${code}`,
        };
        console.log('[SEND_ERROR]', JSON.stringify(errorPayload));
        reject(new Error(errorPayload.error));
      } else {
        resolve();
      }
    });
  });
}

function normalizeImageExtension(mediaType) {
  const mt = String(mediaType || '').toLowerCase();
  if (mt === 'image/jpeg' || mt === 'image/jpg') return '.jpg';
  if (mt === 'image/gif') return '.gif';
  if (mt === 'image/webp') return '.webp';
  if (mt === 'image/bmp') return '.bmp';
  if (mt === 'image/svg+xml') return '.svg';
  return '.png';
}

async function prepareImageAttachments(attachments, tempImageFiles) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { count: 0, promptSuffix: '' };
  }

  const imageAttachments = attachments.filter((attachment) => {
    const mediaType = String(attachment?.mediaType || '').toLowerCase();
    return mediaType.startsWith('image/') && typeof attachment?.data === 'string' && attachment.data.length > 0;
  });

  if (imageAttachments.length === 0) {
    return { count: 0, promptSuffix: '' };
  }

  const tempDir = path.join(os.tmpdir(), 'cursor-images');
  await fs.mkdir(tempDir, { recursive: true });

  const lines = [
    '以下是本地图片附件路径，请优先读取并分析图片内容：',
  ];
  let index = 0;

  for (const attachment of imageAttachments) {
    try {
      const extension = normalizeImageExtension(attachment.mediaType);
      const filename = `cursor-img-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
      const filePath = path.join(tempDir, filename);
      const bytes = Buffer.from(attachment.data, 'base64');
      await fs.writeFile(filePath, bytes);
      tempImageFiles.push(filePath);
      index += 1;
      lines.push(`${index}. ${filePath}`);
      lines.push(`![attachment-${index}](${filePath})`);
    } catch (error) {
      logCursorDiag('attachments.image_prepare_failed', {
        mediaType: attachment?.mediaType || '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (index === 0) {
    return { count: 0, promptSuffix: '' };
  }

  lines.push('请基于以上图片回答；若当前模型不支持视觉输入，请明确说明。');
  return { count: index, promptSuffix: lines.join('\n') };
}

async function cleanupTempImageFiles(tempImageFiles) {
  if (!Array.isArray(tempImageFiles) || tempImageFiles.length === 0) {
    return;
  }
  await Promise.all(
    tempImageFiles.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        // ignore
      }
    })
  );
}

export async function listModels() {
  return new Promise((resolve, reject) => {
    const child = spawn('cursor-agent', ['models'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

    child.on('error', (err) => {
      reject(new Error(`Cursor CLI failed to start: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Cursor CLI exited with code ${code}: ${stderr.join('').trim()}`));
        return;
      }

      const output = stdout.join('').split('\n');
      const models = [];
      let currentModel = null;
      let defaultModel = null;

      for (const rawLine of output) {
        const line = rawLine.trim();
        if (!line || line.toLowerCase().startsWith('available models')) {
          continue;
        }
        const match = line.match(/^(\S+)\s+-\s+(.+)$/);
        if (!match) continue;

        const id = match[1];
        let label = match[2];
        let isCurrent = false;
        let isDefault = false;

        if (label.includes('(current)')) {
          isCurrent = true;
          label = label.replace(/\s*\(current\)\s*/g, ' ');
        }
        if (label.includes('(default)')) {
          isDefault = true;
          label = label.replace(/\s*\(default\)\s*/g, ' ');
        }

        label = label.trim();
        if (isCurrent) currentModel = id;
        if (isDefault) defaultModel = id;

        models.push({
          id,
          label,
          description: label,
          isCurrent,
          isDefault,
        });
      }

      resolve({
        success: true,
        models,
        currentModel,
        defaultModel,
      });
    });
  });
}
