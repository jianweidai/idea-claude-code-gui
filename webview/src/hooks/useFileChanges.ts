import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { FileChangeSummary, EditOperation, FileChangeStatus } from '../types/fileChanges';
import { getFileName } from '../utils/helpers';
import { FILE_MODIFY_TOOL_NAMES, hasEditLikeInput, isToolName } from '../utils/toolConstants';

/** Write tool names that indicate a new file */
const WRITE_TOOL_NAMES = new Set(['write', 'create_file']);

/**
 * Maximum lines to use LCS algorithm.
 * LCS has O(n*m) time and space complexity.
 * For files > 100 lines, we use a faster estimation to prevent UI freezes.
 * Threshold chosen based on: 100*100 = 10,000 operations, acceptable for UI thread.
 */
const LCS_MAX_LINES = 100;

/** Cache for diff calculations to avoid redundant computations */
const diffCache = new Map<string, { additions: number; deletions: number }>();
const DIFF_CACHE_MAX_SIZE = 100;
const DEBUG_FILE_CHANGES = true;

/**
 * Generate cache key from strings (using hash-like approach for large strings)
 */
function getDiffCacheKey(oldString: string, newString: string): string {
  // For small strings, use direct comparison
  if (oldString.length + newString.length < 500) {
    return `${oldString.length}:${newString.length}:${oldString.slice(0, 50)}:${newString.slice(0, 50)}`;
  }
  // For larger strings, use length + first/last chars as key
  return `${oldString.length}:${newString.length}:${oldString.slice(0, 30)}:${oldString.slice(-20)}:${newString.slice(0, 30)}:${newString.slice(-20)}`;
}

/**
 * Compute diff statistics (additions and deletions count)
 * Using LCS-based algorithm for accuracy, with fallback for large files.
 * Results are cached to avoid redundant computations.
 */
function computeDiffStats(oldString: string, newString: string): { additions: number; deletions: number } {
  // Check cache first
  const cacheKey = getDiffCacheKey(oldString, newString);
  const cached = diffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  let result: { additions: number; deletions: number };

  if (oldLines.length === 0 && newLines.length === 0) {
    result = { additions: 0, deletions: 0 };
  } else if (oldLines.length === 0) {
    result = { additions: newLines.length, deletions: 0 };
  } else if (newLines.length === 0) {
    result = { additions: 0, deletions: oldLines.length };
  } else {
    const m = oldLines.length;
    const n = newLines.length;

    if (m > LCS_MAX_LINES || n > LCS_MAX_LINES) {
      // Fallback to simple estimation for large files to prevent UI freezes
      const diff = n - m;
      result = diff >= 0
        ? { additions: diff, deletions: 0 }
        : { additions: 0, deletions: -diff };
    } else {
      // LCS-based diff count for reasonable file sizes
      result = computeLcsDiff(oldLines, newLines, m, n);
    }
  }

  // Cache result with size limit
  if (diffCache.size >= DIFF_CACHE_MAX_SIZE) {
    // Remove oldest entry (first key)
    const firstKey = diffCache.keys().next().value;
    if (firstKey) diffCache.delete(firstKey);
  }
  diffCache.set(cacheKey, result);

  return result;
}

/**
 * LCS-based diff calculation (extracted for clarity)
 */
function computeLcsDiff(
  oldLines: string[],
  newLines: string[],
  m: number,
  n: number
): { additions: number; deletions: number } {
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return { additions, deletions };
}

/**
 * Extract file path from tool input (handles various naming conventions)
 */
function extractFilePath(input: Record<string, unknown>): string | null {
  return (
    (input.file_path as string | undefined) ??
    (input.filePath as string | undefined) ??
    (input.path as string | undefined) ??
    (input.file as string | undefined) ??
    (input.fileName as string | undefined) ??
    (input.filename as string | undefined) ??
    (input.absolute_path as string | undefined) ??
    (input.absolutePath as string | undefined) ??
    (input.relative_workspace_path as string | undefined) ??
    (input.relativeWorkspacePath as string | undefined) ??
    (input.workspace_path as string | undefined) ??
    (input.workspacePath as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.targetFile as string | undefined) ??
    (input.notebook_path as string | undefined) ??
    null
  );
}

function pickString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === 'string' ? item : ''))
        .filter(Boolean)
        .join('\n');
      if (joined) return joined;
    }
    if (value && typeof value === 'object') {
      try {
        const maybeText = (value as Record<string, unknown>).text;
        if (typeof maybeText === 'string' && maybeText) return maybeText;
        const maybeContent = (value as Record<string, unknown>).content;
        if (typeof maybeContent === 'string' && maybeContent) return maybeContent;
        const json = JSON.stringify(value);
        if (json && json !== '{}' && json !== '[]') return json;
      } catch {
      }
    }
  }
  return '';
}

interface StructuredEdit {
  filePath?: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  originalContent?: string;
}

function parseStructuredEdit(entry: unknown): StructuredEdit | null {
  if (!entry || typeof entry !== 'object') return null;
  const edit = entry as Record<string, unknown>;
  const nestedInput =
    (edit.input && typeof edit.input === 'object' ? (edit.input as Record<string, unknown>) : undefined) ??
    (edit.args && typeof edit.args === 'object' ? (edit.args as Record<string, unknown>) : undefined);
  const source = nestedInput ?? edit;

  const filePath = extractFilePath(source) ?? extractFilePath(edit);
  const oldString = pickString(source, [
    'old_string',
    'oldString',
    'old_text',
    'oldText',
    'search',
    'search_text',
    'searchText',
    'find',
    'find_text',
    'findText',
    'from',
  ]);
  const newString = pickString(source, [
    'new_string',
    'newString',
    'new_text',
    'newText',
    'replacement',
    'replace',
    'replace_with',
    'replaceWith',
    'to',
    'content',
  ]);
  const replaceAll =
    (source.replace_all as boolean | undefined) ??
    (source.replaceAll as boolean | undefined);
  const originalContent = pickString(source, [
    'originalContent',
    'original_content',
    'original_content_snapshot',
    'originalSnapshot',
  ]);

  if (!oldString && !newString && !filePath) {
    return null;
  }
  return { filePath: filePath ?? undefined, oldString, newString, replaceAll, originalContent };
}

function extractStructuredEdits(input: Record<string, unknown>): StructuredEdit[] {
  const candidates: unknown[] = [];
  const edits = input.edits;
  if (Array.isArray(edits)) candidates.push(...edits);
  const operations = input.operations;
  if (Array.isArray(operations)) candidates.push(...operations);
  const changes = input.changes;
  if (Array.isArray(changes)) candidates.push(...changes);

  const parsed: StructuredEdit[] = [];
  for (const candidate of candidates) {
    const normalized = parseStructuredEdit(candidate);
    if (normalized) parsed.push(normalized);
  }
  return parsed;
}

/**
 * Extract old and new strings from tool input
 */
function extractStrings(input: Record<string, unknown>): { oldString: string; newString: string; replaceAll?: boolean; originalContent?: string } {
  const oldString = pickString(input, [
    'old_string',
    'oldString',
    'old_text',
    'oldText',
    'search',
    'search_text',
    'searchText',
    'find',
    'find_text',
    'findText',
    'from',
  ]);
  const newString = pickString(input, [
    'new_string',
    'newString',
    'new_text',
    'newText',
    'replacement',
    'replace',
    'replace_with',
    'replaceWith',
    'to',
    'content', // Write tool uses 'content'
    'stream_content',
    'streamContent',
  ]);
  const replaceAll = input.replace_all as boolean | undefined ?? input.replaceAll as boolean | undefined;
  const originalContent = pickString(input, [
    'originalContent',
    'original_content',
    'original_content_snapshot',
    'originalSnapshot',
  ]);

  return { oldString, newString, replaceAll, originalContent };
}

/**
 * Determine file status (A = Added, M = Modified)
 */
function determineFileStatus(operations: EditOperation[]): FileChangeStatus {
  if (operations.length === 0) return 'M';

  const firstOp = operations[0];
  // Write/create_file tools indicate a new file
  if (WRITE_TOOL_NAMES.has(firstOp.toolName.toLowerCase())) {
    return 'A';
  }
  // If first operation has empty oldString, it's likely a new file
  if (firstOp.oldString === '' && firstOp.newString !== '') {
    return 'A';
  }
  return 'M';
}

/**
 * Check if a tool result indicates success
 */
function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}

interface UseFileChangesParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  /** Start processing messages from this index (for Keep All feature) */
  startFromIndex?: number;
}

/**
 * Hook to extract and aggregate file changes from messages
 */
export function useFileChanges({
  messages,
  getContentBlocks,
  findToolResult,
  startFromIndex = 0,
}: UseFileChangesParams): FileChangeSummary[] {
  return useMemo(() => {
    let toolUseBlockCount = 0;
    let recognizedFileToolCount = 0;
    let successfulFileToolCount = 0;
    let structuredEditCount = 0;
    const toolNameStats = new Map<string, number>();

    // Map to collect operations by file path
    const fileOperationsMap = new Map<string, EditOperation[]>();
    const fileOriginalContentMap = new Map<string, string>();

    // Iterate through messages starting from startFromIndex
    messages.forEach((message, messageIndex) => {
      // Skip messages before startFromIndex
      if (messageIndex < startFromIndex) return;

      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);

      blocks.forEach((block) => {
        if (block.type !== 'tool_use') return;
        toolUseBlockCount += 1;

        const toolName = block.name?.toLowerCase() ?? '';
        toolNameStats.set(toolName || '(empty)', (toolNameStats.get(toolName || '(empty)') ?? 0) + 1);

        // Check if this is a file modification tool
        const input = block.input as Record<string, unknown> | undefined;
        const isFileModifyTool = isToolName(toolName, FILE_MODIFY_TOOL_NAMES) || hasEditLikeInput(input);
        if (!isFileModifyTool) return;
        recognizedFileToolCount += 1;

        if (!input) return;

        // Check if operation completed successfully
        const result = findToolResult(block.id, messageIndex);
        if (!isSuccessfulResult(result)) return;
        successfulFileToolCount += 1;

        const filePath = extractFilePath(input);
        const structuredEdits = extractStructuredEdits(input);
        if (structuredEdits.length > 0) {
          structuredEditCount += structuredEdits.length;
          structuredEdits.forEach((edit) => {
            const targetPath = edit.filePath ?? filePath;
            if (!targetPath) return;
            const { additions, deletions } = computeDiffStats(edit.oldString, edit.newString);
            const operation: EditOperation = {
              toolName,
              oldString: edit.oldString,
              newString: edit.newString,
              additions,
              deletions,
              replaceAll: edit.replaceAll,
            };
            const existing = fileOperationsMap.get(targetPath) ?? [];
            existing.push(operation);
            fileOperationsMap.set(targetPath, existing);
            if (edit.originalContent && !fileOriginalContentMap.has(targetPath)) {
              fileOriginalContentMap.set(targetPath, edit.originalContent);
            }
          });
          return;
        }

        if (!filePath) return;

        const { oldString, newString, replaceAll, originalContent } = extractStrings(input);
        const existing = fileOperationsMap.get(filePath) ?? [];
        const derivedOldString =
          !oldString && newString && existing.length > 0
            ? (existing[existing.length - 1].newString ?? '')
            : oldString;
        const { additions, deletions } = computeDiffStats(derivedOldString, newString);

        const operation: EditOperation = {
          toolName,
          oldString: derivedOldString,
          newString,
          additions,
          deletions,
          replaceAll,
        };

        // Group by file path
        existing.push(operation);
        fileOperationsMap.set(filePath, existing);
        if (originalContent && !fileOriginalContentMap.has(filePath)) {
          fileOriginalContentMap.set(filePath, originalContent);
        }
      });
    });

    // Convert map to array of summaries
    const summaries: FileChangeSummary[] = [];

    fileOperationsMap.forEach((operations, filePath) => {
      // Calculate totals
      const totalAdditions = operations.reduce((sum, op) => sum + (op.additions || 0), 0);
      const totalDeletions = operations.reduce((sum, op) => sum + (op.deletions || 0), 0);

      // Defensive: ensure status is a valid string
      const rawStatus = determineFileStatus(operations);
      const status: FileChangeStatus = rawStatus === 'A' ? 'A' : 'M';

      summaries.push({
        filePath: String(filePath || ''),
        fileName: String(getFileName(filePath) || filePath || 'unknown'),
        status,
        originalContent: fileOriginalContentMap.get(filePath),
        additions: totalAdditions,
        deletions: totalDeletions,
        operations,
      });
    });

    // Sort: Added files first, then by file path
    summaries.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'A' ? -1 : 1;
      }
      return a.filePath.localeCompare(b.filePath);
    });

    if (DEBUG_FILE_CHANGES) {
      console.log('[FileChanges] summary', {
        messages: messages.length,
        startFromIndex,
        toolUseBlockCount,
        recognizedFileToolCount,
        successfulFileToolCount,
        structuredEditCount,
        toolNames: Array.from(toolNameStats.entries()),
        files: summaries.map((s) => ({
          filePath: s.filePath,
          additions: s.additions,
          deletions: s.deletions,
          operations: s.operations.length,
        })),
      });
    }

    return summaries;
  }, [messages, getContentBlocks, findToolResult, startFromIndex]);
}
