import type { Grant, Member, Source } from './contracts.js';

// Public, synthetic, loopback-only credentials; never used without --dev-fixture.
export const DEV = Object.freeze({
  humanToken: 'dev-fixture-alex', agentToken: 'dev-fixture-sam', strangerToken: 'dev-fixture-guest',
  runtimeToken: 'dev-fixture-runtime-control', humanId: 'alex', agentId: 'sam',
  conversationId: 'design-room', threadId: 'runtime-design',
});
export const members: Member[] = [
  { id: 'alex', kind: 'human', name: 'Alex' },
  { id: 'sam', kind: 'agent', name: 'Sam', workMode: 'explore' },
  { id: 'guest', kind: 'human', name: 'Guest' },
];
export function developmentGrants(): Grant[] {
  return [DEV.humanId, DEV.agentId].map(memberId => ({
    id: `fixture-grant-${memberId}`, revision: 1, memberId,
    conversationId: DEV.conversationId, threadId: DEV.threadId,
    actions: ['read', 'send', 'claim', 'request_approval', 'cancel'],
    expiresAt: Date.now() + 3600000, revoked: false,
  }));
}
export const fixtureSources: Source[] = [
  { id: 'fixture-a', title: 'Synthetic protocol note A', url: 'https://fixtures.invalid/protocol/a', excerpt: 'An accepted cancel request is distinct from a settled execution.' },
  { id: 'fixture-b', title: 'Synthetic protocol note B', url: 'https://fixtures.invalid/protocol/b', excerpt: 'A runtime session is separate from the stable team member identity.' },
];
export function requireDevMode(): void {
  if (!process.argv.includes('--dev-fixture')) throw new Error('This prototype requires explicit --dev-fixture. No production authorization defaults exist.');
}
