/**
 * Cursor channel command handler – isolates Cursor CLI logic.
 */
import { sendMessage as cursorSendMessage, listModels as cursorListModels } from '../services/cursor/message-service.js';

/**
 * Execute a Cursor command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleCursorCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const { message, sessionId, cwd, model, permissionMode, cursorMode, attachments } = stdinData;
        await cursorSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          permissionMode || '',
          cursorMode || '',
          attachments || []
        );
      } else {
        await cursorSendMessage(args[0], args[1], args[2], args[3], args[4], args[5]);
      }
      break;
    }
    case 'listModels': {
      const result = await cursorListModels();
      console.log(JSON.stringify(result));
      break;
    }
    default:
      throw new Error(`Unknown Cursor command: ${command}`);
  }
}

export function getCursorCommandList() {
  return ['send', 'listModels'];
}
