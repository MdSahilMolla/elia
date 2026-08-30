import type { SlashCommand } from '../slashPrompt.ts'

export const REPL_COMMANDS_FOR_TEST: SlashCommand[] = [
  { name: '/cost', description: 'session token breakdown' },
  { name: '/export', description: 'export to markdown' },
  { name: '/help', description: 'list commands' },
]
