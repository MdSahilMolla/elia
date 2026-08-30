import { getSynthesizedTools } from '../tools/registry.ts'

/**
 * Skill selection, without making the user pick. Every loaded skill is already a
 * callable tool the model sees — but with a dozen of them the model can miss the
 * one that fits. This ranks them against the task and puts the best matches at
 * the top of the system prompt: "these skills look relevant here".
 */

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'is', 'it', 'and', 'or', 'for', 'on', 'with', 'my', 'me', 'you', 'this', 'that', 'can', 'please', 'i'])

function terms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t))
}

export interface RankedSkill {
  name: string
  description: string
  score: number
}

export function rankSkills(prompt: string, skills = getSynthesizedTools()): RankedSkill[] {
  const promptTerms = new Set(terms(prompt))
  if (promptTerms.size === 0) return []
  return skills
    .map((skill) => {
      const haystack = terms(`${skill.name} ${skill.description}`)
      const score = haystack.reduce((sum, t) => sum + (promptTerms.has(t) ? 1 : 0), 0)
      return { name: skill.name, description: skill.description.split('\n')[0]!.slice(0, 100), score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** A system-prompt section pointing at the skills that fit this task, or '' when none clearly do. */
export function renderSkillHint(prompt: string, skills = getSynthesizedTools()): string {
  if (skills.length === 0) return ''
  const ranked = rankSkills(prompt, skills).slice(0, 3)
  if (ranked.length === 0) return ''
  const lines = ranked.map((s) => `- ${s.name}: ${s.description}`)
  return `\n\n## Skills that fit this task\nYou have learned tools for this — prefer them over doing it by hand:\n${lines.join('\n')}`
}
