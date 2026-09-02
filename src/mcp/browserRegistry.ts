import type { Tool } from '../tools/types.ts'
import type { BrowserAction } from '../tools/browser.ts'

interface BrowserMcpTool { server: string; originalName: string; tool: Tool }
const entries: BrowserMcpTool[] = []
const candidates: Record<BrowserAction, string[]> = {
  status: ['browser_status', 'browser_snapshot'], navigate: ['browser_navigate'], refresh: ['browser_refresh', 'browser_reload'], back: ['browser_back', 'browser_go_back', 'browser_navigate_back'], forward: ['browser_forward', 'browser_go_forward', 'browser_navigate_forward'], snapshot: ['browser_snapshot'], click: ['browser_click'], type: ['browser_type'], press: ['browser_press', 'browser_press_key'], scroll: ['browser_scroll'], wait: ['browser_wait'], wait_for: ['browser_wait_for'], extract: ['browser_extract', 'browser_snapshot'], verify: ['browser_snapshot'],
}

export function registerBrowserMcpTool(server: string, originalName: string, tool: Tool): void {
  if (!/^browser_/i.test(originalName)) return
  entries.push({ server, originalName: originalName.toLowerCase(), tool })
}
export function findBrowserMcpTool(action: BrowserAction, preferredServer?: string): BrowserMcpTool | undefined {
  const names = candidates[action]
  return entries.find((entry) => (!preferredServer || entry.server === preferredServer) && names.includes(entry.originalName))
}
export function browserMcpReadiness(): { servers: string[]; tools: string[] } {
  return { servers: [...new Set(entries.map((entry) => entry.server))], tools: entries.map((entry) => `${entry.server}:${entry.originalName}`) }
}
export function clearBrowserMcpToolsForTests(): void { entries.length = 0 }
