/**
 * Deterministic chat transcript shaped like a long real session: alternating user/assistant
 * messages whose assistant turns carry large tool outputs. Sized by the caller so benchmarks
 * and QA fixtures share one generator and never need a private transcript on disk.
 */

import type { UIMessage } from 'ai';

export type SyntheticTranscriptOptions = {
  /** Total messages; assistant turns take the even indices' successors (user, assistant, ...). */
  messages: number;
  /** Approximate JSON bytes of each assistant message's tool output. */
  bytesPerAssistantMessage: number;
  seed?: number;
};

/** Small linear congruential generator: same seed, same transcript, on every machine. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  'agent',
  'chunk',
  'render',
  'commit',
  'query',
  'socket',
  'worktree',
  'flow',
  'diff',
  'cache',
];

function prose(next: () => number, bytes: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    const word = WORDS[Math.floor(next() * WORDS.length)] ?? 'agent';
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ');
}

export function syntheticTranscript({
  messages,
  bytesPerAssistantMessage,
  seed = 7,
}: SyntheticTranscriptOptions): UIMessage[] {
  const next = pseudoRandom(seed);
  const out: UIMessage[] = [];
  for (let index = 0; index < messages; index += 1) {
    if (index % 2 === 0) {
      out.push({
        id: `user-${index}`,
        role: 'user',
        parts: [{ type: 'text', text: prose(next, 120) }],
      });
      continue;
    }
    out.push({
      id: `assistant-${index}`,
      role: 'assistant',
      parts: [
        {
          type: 'tool-Bash',
          toolCallId: `call-${index}`,
          state: 'output-available',
          input: { command: `grep -rn ${WORDS[index % WORDS.length]} src` },
          output: prose(next, bytesPerAssistantMessage),
        },
        { type: 'text', text: prose(next, 600) },
      ],
      metadata: {
        sdkMessageUuid: `sdk-${index}`,
        usage: { inputTokens: index, outputTokens: index * 2 },
      },
    });
  }
  return out;
}
