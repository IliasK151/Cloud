// The Claude models the floor's LLM brain can think with, and what each costs per million
// tokens (Anthropic's prices; cache writes at 1.25× input, reads as listed). Opus is the
// default: the best judgement. Haiku costs a fortieth of it for the same work, if the budget
// matters more.
export const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5 (best)', input: 4, output: 20, cacheRead: 0.2, fallbacks: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 (faster, half the cost)', input: 2, output: 10, cacheRead: 0.2, fallbacks: true },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 (cheapest)', input: 0.1, output: 0.5, cacheRead: 0.01, fallbacks: false },
};
export const DEFAULT_MODEL = 'claude-opus-5-5';

// What one answer cost, from the usage the API reports.
export function costOf(model, usage = {}) {
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const per = 1e6;
  const input = (usage.input_tokens || 0) * m.input;
  const write = (usage.cache_creation_input_tokens || 0) * m.input * 1.25;
  const read = (usage.cache_read_input_tokens || 0) * m.cacheRead;
  const output = (usage.output_tokens || 0) * m.output;
  return (input + write + read + output) / per;
}
