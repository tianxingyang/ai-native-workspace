import type { Message } from './contracts.js';
export interface ParticipationDecision { participate: boolean; reason: string }
/** Deliberately small development policy, evaluated only after visibility checks. */
export function decideParticipation(message: Message, authorKind: 'human' | 'agent'): ParticipationDecision {
  if (authorKind === 'agent' || message.origin !== 'chat') return { participate: false, reason: 'agent_output_does_not_trigger_research' };
  if (/(不用|不要|无需|别再).{0,8}(调研|研究|查找)|\b(do not|don\x27t|no need to)\s+(research|investigate)/i.test(message.text)) return { participate: false, reason: 'explicit_no_research' };
  if (/(调研|研究一下|查找资料|查一下|比较一下)|\b(research|investigate|compare)\b/i.test(message.text)) return { participate: true, reason: 'explicit_research_intent_without_mention' };
  return { participate: false, reason: 'no_clear_research_intent' };
}
