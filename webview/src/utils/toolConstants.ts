/**
 * Tool name constants for consistent tool identification across the application.
 * Centralizes tool name definitions to prevent inconsistencies.
 */

// Read/file viewing tools
export const READ_TOOL_NAMES = new Set(['read', 'read_file']);

// Edit/file modification tools
export const EDIT_TOOL_NAMES = new Set([
  'edit',
  'edit_file',
  'replace_string',
  'write_to_file',
  'edittoolcall',
  'batch_edit_files',
  'batcheditfiles',
  'multiedit',
]);

// Bash/command execution tools
export const BASH_TOOL_NAMES = new Set(['bash', 'run_terminal_cmd', 'execute_command', 'shell_command']);

// File modification tools (for rewind feature - includes write for new file creation)
export const FILE_MODIFY_TOOL_NAMES = new Set([
  'write',
  'edit',
  'edit_file',
  'replace_string',
  'write_to_file',
  'edittoolcall',
  'writetoolcall',
  'batch_edit_files',
  'batcheditfiles',
  'multiedit',
  'notebookedit',
  'create_file',
]);

/**
 * Heuristic check: some providers use non-standard tool names but still carry
 * edit payloads (old/new strings or structured edits arrays).
 */
export function hasEditLikeInput(input: Record<string, unknown> | undefined): boolean {
  if (!input || typeof input !== 'object') return false;

  const hasFilePath =
    typeof input.file_path === 'string' ||
    typeof input.filePath === 'string' ||
    typeof input.path === 'string' ||
    typeof input.target_file === 'string' ||
    typeof input.targetFile === 'string';

  const hasDirectEditFields =
    typeof input.old_string === 'string' ||
    typeof input.oldString === 'string' ||
    typeof input.old_text === 'string' ||
    typeof input.oldText === 'string' ||
    typeof input.new_string === 'string' ||
    typeof input.newString === 'string' ||
    typeof input.new_text === 'string' ||
    typeof input.newText === 'string' ||
    typeof input.replacement === 'string' ||
    typeof input.replace === 'string';

  if (hasFilePath && hasDirectEditFields) {
    return true;
  }

  const hasStructuredEdits =
    Array.isArray(input.edits) ||
    Array.isArray(input.operations) ||
    Array.isArray(input.changes);

  return hasStructuredEdits || (hasFilePath && hasDirectEditFields);
}

/**
 * Check if a tool name matches a set of tool names (case-insensitive)
 */
export function isToolName(toolName: string | undefined, toolSet: Set<string>): boolean {
  return toolName !== undefined && toolSet.has(toolName.toLowerCase());
}
