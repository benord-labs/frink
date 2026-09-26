import { z } from 'zod';
import { SUBAGENT_TEXT_PART_TYPE } from '../../../../../shared/subagent-parts';
import { getDatabase } from '../../../db';
import { getChatById as getChatByIdLocal } from '../../../db/repos/chats';
import { getProjectById } from '../../../db/repos/projects';
import {
  getSubChatById as getSubChatByIdLocal,
  listSubChatsByChat as listSubChatsByChatLocal,
} from '../../../db/repos/sub-chats';
import { publicProcedure, router } from '../../index';

/**
 * A subagent's prose, which an export must render as the words it is — not as
 * "[used SubagentText tool]". It only travels in tool clothing so its id can attribute it to a card.
 */
function subagentProse(part: { type?: string; input?: Record<string, unknown> }): string | null {
  if (part.type !== SUBAGENT_TEXT_PART_TYPE) return null;
  return typeof part.input?.text === 'string' && part.input.text.trim() ? part.input.text : null;
}

// Regex patterns for filename sanitization - hoisted to module level for performance
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional for filename sanitization
const CONTROL_AND_INVALID_CHARS_REGEX = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE_REGEX = /\s+/g;
const MULTIPLE_UNDERSCORES_REGEX = /_+/g;
const LEADING_TRAILING_UNDERSCORES_REGEX = /^_|_$/g;

// Function to sanitize filename - remove invalid characters
function createFilenameSanitizer(): (name: string) => string {
  return (name: string) => {
    return (
      name
        .replace(CONTROL_AND_INVALID_CHARS_REGEX, '_') // Invalid chars
        .replace(WHITESPACE_REGEX, '_') // Replace spaces with underscores
        .replace(MULTIPLE_UNDERSCORES_REGEX, '_') // Collapse multiple underscores
        .replace(LEADING_TRAILING_UNDERSCORES_REGEX, '') // Trim underscores from ends
        .slice(0, 100) || // Limit length
      'chat'
    ); // Fallback if empty
  };
}

const sanitizeFilenameGlobal = createFilenameSanitizer();

/**
 * Chat export operations
 * Purpose: Export conversations from Neon to various formats (JSON, Markdown, Text)
 */
export const exportRouter = router({
  /**
   * Export a chat conversation to various formats.
   * Supports exporting entire workspace or a single sub-chat.
   * Useful for sharing, backup, or importing into other tools.
   */
  exportChat: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string().optional(), // If provided, export only this sub-chat
        format: z.enum(['json', 'markdown', 'text']).default('markdown'),
      }),
    )
    .query(async ({ input }) => {
      const db = getDatabase();
      const chat = await getChatByIdLocal(db, input.chatId);

      if (!chat) {
        throw new Error('Chat not found');
      }

      const project = chat.projectId ? await getProjectById(db, chat.projectId) : null;

      type ChatSubChatExport = { id: string; name: string | null; messages: unknown };
      let chatSubChats: ChatSubChatExport[];

      if (input.subChatId) {
        const subChat = await getSubChatByIdLocal(db, input.subChatId);
        if (!subChat || subChat.chatId !== input.chatId) {
          throw new Error('Sub-chat not found');
        }
        chatSubChats = [{ id: subChat.id, name: subChat.name, messages: subChat.messages }];
      } else {
        const subChats = await listSubChatsByChatLocal(db, input.chatId);
        chatSubChats = subChats.map((sc) => ({
          id: sc.id,
          name: sc.name,
          messages: sc.messages,
        }));
      }

      // Parse messages from sub-chats (messages are already parsed from Neon JSONB)
      const allMessages: Array<{
        subChatId: string;
        subChatName: string | null;
        messages: Array<{
          id: string;
          role: string;
          parts: Array<{
            type: string;
            text?: string;
            toolName?: string;
            input?: Record<string, unknown>;
          }>;
          metadata?: Record<string, unknown>;
        }>;
      }> = [];

      for (const subChat of chatSubChats) {
        try {
          const messages = (subChat.messages || []) as Array<{
            id: string;
            role: string;
            parts: Array<{
              type: string;
              text?: string;
              toolName?: string;
              input?: Record<string, unknown>;
            }>;
            metadata?: Record<string, unknown>;
          }>;
          allMessages.push({
            subChatId: subChat.id,
            subChatName: subChat.name,
            messages,
          });
        } catch {
          // skip invalid data
        }
      }

      // Sanitize filename - remove characters that are invalid on Windows/macOS/Linux
      const sanitizeFilename = sanitizeFilenameGlobal;

      // Use sub-chat name if exporting single sub-chat, otherwise use chat name
      const exportName =
        input.subChatId && chatSubChats[0]?.name
          ? `${chat.name || 'chat'}-${chatSubChats[0].name}`
          : chat.name || 'chat';
      const safeFilename = sanitizeFilename(exportName);

      if (input.format === 'json') {
        return {
          format: 'json' as const,
          content: JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              chat: {
                id: chat.id,
                name: chat.name,
                createdAt: chat.createdAt,
                branch: chat.branch,
                baseBranch: chat.baseBranch,
                prUrl: chat.prUrl,
              },
              project,
              conversations: allMessages,
            },
            null,
            2,
          ),
          filename: `${safeFilename}-${chat.id.slice(0, 8)}.json`,
        };
      }

      if (input.format === 'text') {
        // plain text format
        let text: string = `# ${chat.name || 'Untitled Chat'}\n`;
        text += `exported: ${new Date().toISOString()}\n`;
        if (project) {
          text += `project: ${project.name}\n`;
        }
        text += `\n---\n\n`;

        for (const subChatData of allMessages) {
          if (subChatData.subChatName) {
            text += `## ${subChatData.subChatName}\n\n`;
          }

          for (const msg of subChatData.messages) {
            const role = msg.role === 'user' ? 'You' : 'Assistant';
            text += `${role}:\n`;

            for (const part of msg.parts || []) {
              const body = part.type === 'text' ? part.text : subagentProse(part);
              if (body) {
                text += `${body}\n`;
              } else if (part.type?.startsWith('tool-') && part.toolName) {
                text += `[used ${part.toolName} tool]\n`;
              }
            }
            text += '\n';
          }
        }

        return {
          format: 'text' as const,
          content: text,
          filename: `${safeFilename}-${chat.id.slice(0, 8)}.txt`,
        };
      }

      // markdown format (default)
      let markdown: string = `# ${chat.name || 'Untitled Chat'}\n\n`;
      markdown += `**Exported:** ${new Date().toISOString()}\n\n`;
      if (project) {
        markdown += `**Project:** ${project.name}\n\n`;
      }
      if (chat.branch) {
        markdown += `**Branch:** \`${chat.branch}\`\n\n`;
      }
      if (chat.prUrl) {
        markdown += `**PR:** [${chat.prUrl}](${chat.prUrl})\n\n`;
      }
      markdown += `---\n\n`;

      for (const subChatData of allMessages) {
        if (subChatData.subChatName) {
          markdown += `## ${subChatData.subChatName}\n\n`;
        }

        for (const msg of subChatData.messages) {
          const role = msg.role === 'user' ? '**You**' : '**Assistant**';
          markdown += `### ${role}\n\n`;

          for (const part of msg.parts || []) {
            const body = part.type === 'text' ? part.text : subagentProse(part);
            if (body) {
              markdown += `${body}\n\n`;
            } else if (part.type?.startsWith('tool-') && part.toolName) {
              const toolName = part.toolName;
              if (toolName === 'Bash' && part.input?.command) {
                markdown += `\`\`\`bash\n${part.input.command}\n\`\`\`\n\n`;
              } else if ((toolName === 'Edit' || toolName === 'Write') && part.input?.file_path) {
                markdown += `> Modified: \`${part.input.file_path}\`\n\n`;
              } else if (toolName === 'Read' && part.input?.file_path) {
                markdown += `> Read: \`${part.input.file_path}\`\n\n`;
              } else {
                markdown += `> *Used ${toolName} tool*\n\n`;
              }
            }
          }
        }
      }

      return {
        format: 'markdown' as const,
        content: markdown,
        filename: `${safeFilename}-${chat.id.slice(0, 8)}.md`,
      };
    }),
});
