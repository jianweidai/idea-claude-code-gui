import { useCallback } from 'react';
import type { Attachment } from '../types.js';
import type { Dispatch, SetStateAction } from 'react';

interface CompletionLike {
  close: () => void;
}

export interface UseSubmitHandlerOptions {
  getTextContent: () => string;
  attachments: Attachment[];
  isLoading: boolean;
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  currentProvider: string;
  cursorMode?: string;
  onCursorModeChange?: (mode: 'default' | 'plan' | 'ask') => void;
  clearInput: () => void;
  /** Cancel any pending debounced input callbacks to prevent stale values from refilling the input */
  cancelPendingInput: () => void;
  externalAttachments: Attachment[] | undefined;
  setInternalAttachments: Dispatch<SetStateAction<Attachment[]>>;
  fileCompletion: CompletionLike;
  commandCompletion: CompletionLike;
  agentCompletion: CompletionLike;
  recordInputHistory: (text: string) => void;
  onSubmit?: (content: string, attachmentsToSend?: Attachment[]) => void;
  onInstallSdk?: () => void;
  addToast?: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * useSubmitHandler - Submit logic for the chat input box
 *
 * - Validates SDK state and empty input
 * - Records input history
 * - Clears input/attachments for responsiveness
 * - Defers onSubmit to allow UI update
 */
export function useSubmitHandler({
  getTextContent,
  attachments,
  isLoading,
  sdkStatusLoading,
  sdkInstalled,
  currentProvider,
  cursorMode,
  onCursorModeChange,
  clearInput,
  cancelPendingInput,
  externalAttachments,
  setInternalAttachments,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  recordInputHistory,
  onSubmit,
  onInstallSdk,
  addToast,
  t,
}: UseSubmitHandlerOptions) {
  return useCallback(() => {
    const content = getTextContent();
    const cleanContent = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    const cursorCommandMatch = cleanContent.match(/^\/cursor(?:\s+(default|plan|ask))?$/i);
    if (cursorCommandMatch) {
      const targetMode = (cursorCommandMatch[1] || '').toLowerCase();
      if (currentProvider !== 'cursor') {
        addToast?.(t('chat.cursorModeCommandOnlyCursor', { defaultValue: '仅在 Cursor 模式下可用' }), 'info');
        return;
      }
      if (!targetMode) {
        const modeLabelMap: Record<string, string> = {
          default: t('chat.cursorModeLabelDefault', { defaultValue: '默认' }),
          plan: t('chat.cursorModeLabelPlan', { defaultValue: '规划' }),
          ask: t('chat.cursorModeLabelAsk', { defaultValue: '问答' }),
        };
        const currentLabel = modeLabelMap[cursorMode || 'default'] || modeLabelMap.default;
        addToast?.(t('chat.cursorModeCommandHint', {
          mode: currentLabel,
          defaultValue: `当前模式：${currentLabel}（可用：/cursor default|plan|ask）`,
        }), 'info');
        return;
      }
      if (targetMode === 'default' || targetMode === 'plan' || targetMode === 'ask') {
        onCursorModeChange?.(targetMode);
        const modeLabel = targetMode === 'default'
          ? t('chat.cursorModeLabelDefault', { defaultValue: '默认' })
          : targetMode === 'plan'
            ? t('chat.cursorModeLabelPlan', { defaultValue: '规划' })
            : t('chat.cursorModeLabelAsk', { defaultValue: '问答' });
        addToast?.(t('chat.cursorModeCommandSwitched', {
          mode: modeLabel,
          defaultValue: `已切换为${modeLabel}模式`,
        }), 'success');
        // Close completions and clear input
        fileCompletion.close();
        commandCompletion.close();
        agentCompletion.close();
        cancelPendingInput();
        clearInput();
        if (externalAttachments === undefined) {
          setInternalAttachments([]);
        }
        return;
      }
    }

    if (sdkStatusLoading) {
      addToast?.(t('chat.sdkStatusLoading'), 'info');
      return;
    }

    if (!sdkInstalled) {
      const providerLabel = currentProvider === 'codex'
        ? 'Codex'
        : currentProvider === 'cursor'
          ? 'Cursor CLI'
          : 'Claude Code';
      addToast?.(
        t('chat.sdkNotInstalled', { provider: providerLabel }) +
          ' ' +
          t('chat.goInstallSdk'),
        'warning'
      );
      onInstallSdk?.();
      return;
    }

    if (!cleanContent && attachments.length === 0) return;

    // Close completions
    fileCompletion.close();
    commandCompletion.close();
    agentCompletion.close();

    // Record input history
    recordInputHistory(content);

    const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;

    // Cancel any pending debounced input callbacks before clearing
    // This prevents stale values from refilling the input after submit
    cancelPendingInput();
    clearInput();
    if (externalAttachments === undefined) {
      setInternalAttachments([]);
    }

    // Call onSubmit even when loading - let parent handle queueing
    setTimeout(() => {
      onSubmit?.(content, attachmentsToSend);
    }, 10);
  }, [
    getTextContent,
    attachments,
    isLoading,
    sdkStatusLoading,
    sdkInstalled,
    currentProvider,
    cursorMode,
    onCursorModeChange,
    clearInput,
    cancelPendingInput,
    externalAttachments,
    setInternalAttachments,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    recordInputHistory,
    onSubmit,
    onInstallSdk,
    addToast,
    t,
  ]);
}
