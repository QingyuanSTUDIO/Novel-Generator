import type { ChatMessage } from './chat.ts'
import type { ModelSettings } from './modelSettings.ts'

export type ContextBudgetSettings = Pick<ModelSettings, 'contextTokens' | 'maxTokens' | 'historyTokens'>

/** These are local estimates; only provider response usage is an actual count. */
export type ContextBudgetReport = {
  contextTokens: number
  maxTokens: number
  safetyTokens: number
  inputBudget: number
  estimatedInputTokens: number
  historyTokensUsed: number
  trimmedMessages: number
  remainingTokens: number
  /** Estimated input as a percentage of the entire configured context window. */
  usedPercent: number
  estimated: true
}

const asciiWordCharacter = /[A-Za-z0-9_]/
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const emojiCharacter = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u

/**
 * A conservative Unicode-aware heuristic, not a model tokenizer. ASCII word
 * runs cost roughly one token per three characters; Chinese/CJK characters
 * cost two each. Emoji and other Unicode symbols are counted by code point,
 * so surrogate pairs are never mistaken for two text characters.
 *
 * Tokenizers differ by provider/model, so this may over- or under-estimate.
 * prepareContextBudget reserves a separate safety margin; this heuristic is
 * not a guarantee that a provider will accept the entire configured window.
 */
export function estimateTextTokens(text: string) {
  let tokens = 0
  let asciiRun = 0
  let spaceRun = 0
  const flushRuns = () => {
    tokens += Math.ceil(asciiRun / 3) + Math.ceil(spaceRun / 4)
    asciiRun = 0
    spaceRun = 0
  }
  for (const character of text) {
    if (asciiWordCharacter.test(character)) {
      tokens += Math.ceil(spaceRun / 4)
      spaceRun = 0
      asciiRun += 1
      continue
    }
    if (character === ' ' || character === '\t') {
      tokens += Math.ceil(asciiRun / 3)
      asciiRun = 0
      spaceRun += 1
      continue
    }
    flushRuns()
    if (cjkCharacter.test(character)) tokens += 2
    else if (emojiCharacter.test(character)) tokens += 4
    else {
      const codePoint = character.codePointAt(0)!
      // Combining marks and joiners still consume tokens in some tokenizers.
      const utf8Bytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
      tokens += Math.ceil(utf8Bytes / 2)
    }
  }
  flushRuns()
  return tokens
}

/** Six estimated tokens per message account for role/framing overhead. */
export function estimateMessageTokens(messages: readonly ChatMessage[]) {
  return messages.reduce((sum, message) => sum + estimateTextTokens(message.content) + 6, 0)
}

function validateSettings(settings: ContextBudgetSettings) {
  for (const [name, value] of Object.entries(settings)) {
    if (['contextTokens', 'maxTokens', 'historyTokens'].includes(name)
      && (!Number.isSafeInteger(value) || value < (name === 'historyTokens' ? 0 : 1))) {
      throw new Error(`${name} 必须是${name === 'historyTokens' ? '非负' : '正'}整数。`)
    }
  }
  if (!Number.isSafeInteger(settings.contextTokens) || !Number.isSafeInteger(settings.maxTokens)
    || !Number.isSafeInteger(settings.historyTokens)) {
    throw new Error('上下文长度、最大回复长度和对话记忆预算必须是有效整数。')
  }
}

type HistoryRound = { indices: number[]; tokens: number }

/**
 * Keep protocol/system messages and the latest author request intact.
 * Optional history is a contiguous suffix of complete user/assistant rounds,
 * never isolated assistant messages or sliced text. The original transcript
 * is not mutated, so trimming a request cannot delete saved conversations.
 */
export function prepareContextBudget(messages: readonly ChatMessage[], settings: ContextBudgetSettings): {
  messages: ChatMessage[]
  report: ContextBudgetReport
} {
  validateSettings(settings)
  const safetyTokens = Math.max(32, Math.ceil(settings.contextTokens * 0.05))
  const inputBudget = settings.contextTokens - settings.maxTokens - safetyTokens
  if (inputBudget <= 0) {
    throw new Error(`上下文预算不足：窗口 ${settings.contextTokens} tokens，最大回复预留 ${settings.maxTokens} tokens，安全余量 ${safetyTokens} tokens。请增大上下文长度或降低最大回复长度。`)
  }

  let currentUserIndex = -1
  messages.forEach((message, index) => {
    if (message.role === 'user') currentUserIndex = index
  })
  const protectedIndices = new Set<number>()
  messages.forEach((message, index) => {
    if (message.role === 'system' || (currentUserIndex >= 0 && index >= currentUserIndex)) {
      protectedIndices.add(index)
    }
  })
  const mandatoryMessages = messages.filter((_message, index) => protectedIndices.has(index))
  const mandatoryTokens = estimateMessageTokens(mandatoryMessages)
  if (mandatoryTokens > inputBudget) {
    throw new Error(`必要输入超出上下文预算：协议、资料和当前请求约 ${mandatoryTokens} tokens，可用输入预算 ${inputBudget} tokens（窗口 ${settings.contextTokens}、回复预留 ${settings.maxTokens}、安全余量 ${safetyTokens}）。请减少本次资料或增大上下文长度；协议和当前需求不会被截断。`)
  }

  const rounds: HistoryRound[] = []
  let currentRound: number[] = []
  const finishRound = () => {
    if (currentRound.length && currentRound.some((index) => messages[index]!.role === 'assistant')) {
      rounds.push({ indices: currentRound, tokens: estimateMessageTokens(currentRound.map((index) => messages[index]!)) })
    }
    currentRound = []
  }
  messages.forEach((message, index) => {
    if (protectedIndices.has(index)) return
    if (message.role === 'user') {
      finishRound()
      currentRound = [index]
    } else if (message.role === 'assistant' && currentRound.length) {
      currentRound.push(index)
    }
  })
  finishRound()

  const keptIndices = new Set(protectedIndices)
  const historyBudget = Math.min(settings.historyTokens, inputBudget - mandatoryTokens)
  let historyTokensUsed = 0
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!
    if (historyTokensUsed + round.tokens > historyBudget) break
    round.indices.forEach((messageIndex) => keptIndices.add(messageIndex))
    historyTokensUsed += round.tokens
  }
  const preparedMessages = messages
    .filter((_message, index) => keptIndices.has(index))
    .map((message) => ({ role: message.role, content: message.content }))
  const estimatedInputTokens = estimateMessageTokens(preparedMessages)
  return {
    messages: preparedMessages,
    report: {
      contextTokens: settings.contextTokens,
      maxTokens: settings.maxTokens,
      safetyTokens,
      inputBudget,
      estimatedInputTokens,
      historyTokensUsed,
      trimmedMessages: messages.length - preparedMessages.length,
      remainingTokens: inputBudget - estimatedInputTokens,
      usedPercent: Math.round(estimatedInputTokens / settings.contextTokens * 10000) / 100,
      estimated: true,
    },
  }
}
