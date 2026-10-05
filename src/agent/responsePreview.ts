type ReadString = { value: string; end: number; complete: boolean }

const jsonEscapes: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

function safeStringEnd(value: string) {
  // A stream fragment may end halfway through a Unicode surrogate pair.
  // Hold that final code unit until its partner arrives.
  return /[\uD800-\uDBFF]$/u.test(value) ? value.slice(0, -1) : value
}

function readString(source: string, start: number): ReadString {
  let value = ''
  let index = start + 1
  while (index < source.length) {
    const character = source[index]!
    if (character === '"') return { value: safeStringEnd(value), end: index + 1, complete: true }
    if (character === '\\') {
      const escape = source[index + 1]
      if (escape === undefined) break
      if (escape === 'u') {
        const hex = source.slice(index + 2, index + 6)
        if (hex.length !== 4 || !/^[\da-f]{4}$/iu.test(hex)) break
        value += String.fromCharCode(parseInt(hex, 16))
        index += 6
        continue
      }
      if (!(escape in jsonEscapes)) break
      value += jsonEscapes[escape]
      index += 2
      continue
    }
    if (character.charCodeAt(0) < 0x20) break
    value += character
    index += 1
  }
  return { value: safeStringEnd(value), end: index, complete: false }
}

function skipWhitespace(source: string, start: number) {
  let index = start
  while (index < source.length && /\s/u.test(source[index]!)) index += 1
  return index
}

function skipValue(source: string, start: number) {
  let index = start
  let depth = 0
  while (index < source.length) {
    const character = source[index]!
    if (character === '"') {
      const string = readString(source, index)
      if (!string.complete) return source.length
      index = string.end
      continue
    }
    if (character === '[' || character === '{') depth += 1
    else if (character === ']' || character === '}') {
      if (depth === 0) return index
      depth -= 1
    } else if (character === ',' && depth === 0) return index
    index += 1
  }
  return index
}

/**
 * Extract a safe human-readable preview from an incomplete Agent JSON reply.
 *
 * Only a string-valued `message` on the root object is displayed. Nested
 * operation fields, arbitrary protocol JSON and incomplete escape sequences
 * are intentionally kept out of the chat preview.
 */
export function extractAgentMessagePreview(raw: string): string {
  const source = raw.replace(/^\uFEFF/u, '').trimStart().replace(/^```(?:json)?\s*/iu, '')
  if (source[0] !== '{') return ''
  let index = 1
  while (index < source.length) {
    index = skipWhitespace(source, index)
    if (source[index] === '}') return ''
    if (source[index] !== '"') return ''
    const key = readString(source, index)
    if (!key.complete) return ''
    index = skipWhitespace(source, key.end)
    if (source[index] !== ':') return ''
    index = skipWhitespace(source, index + 1)
    if (key.value === 'message') return source[index] === '"' ? readString(source, index).value : ''
    index = skipValue(source, index)
    index = skipWhitespace(source, index)
    if (source[index] !== ',') return ''
    index += 1
  }
  return ''
}
