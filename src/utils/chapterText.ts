export function formatChapterContent(content: string, indentSpaces: number) {
  const indent = '\u3000'.repeat(indentSpaces)
  let insideCodeFence = false
  let paragraphStart = true
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  return lines.map((line, index) => {
    const withoutOldIndent = line.replace(/^\u3000+/, '')
    const asciiIndent = withoutOldIndent.match(/^[ \t]*/)?.[0].length ?? 0
    if (!insideCodeFence && asciiIndent >= 4) {
      paragraphStart = false
      return withoutOldIndent
    }
    const markerCandidate = withoutOldIndent.replace(/^[ \t]+/, '')
    if (/^(?:`{3,}|~{3,})/.test(markerCandidate)) {
      insideCodeFence = !insideCodeFence
      paragraphStart = !insideCodeFence
      return withoutOldIndent
    }
    if (insideCodeFence) return line
    if (!line.trim()) {
      paragraphStart = true
      return ''
    }
    if (!paragraphStart) return line
    paragraphStart = false
    const nextLine = lines[index + 1]?.trim() ?? ''
    const setextHeading = /^={3,}$/.test(nextLine) || /^-{3,}$/.test(nextLine)
    const markdownBlock = /^(?:#{1,6}[ \t]+|>|(?:[-+*]|\d+[.)])[ \t]+|\||(?:\*{3,}|_{3,}|-{3,})$)/.test(markerCandidate)
    if (setextHeading || markdownBlock) return withoutOldIndent
    return `${indent}${withoutOldIndent.replace(/^[ \t\u3000]+/, '')}`
  }).join('\n')
}

export function splitChapterParagraphs(content: string) {
  const normalized = content.replace(/\r\n?/g, '\n')
  return normalized ? normalized.split(/\n[ \t\u3000]*\n+/) : ['']
}

export function markdownToPlainText(markdown: string) {
  const references = new Set<string>()
  const protectedSegments: string[] = []
  const protect = (text: string) => `\u0000TEXT${protectedSegments.push(text) - 1}\u0000`
  const normalizeReference = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  const stripQuotes = (line: string) => {
    let result = line
    while (/^[ \t]{0,3}>/.test(result)) result = result.replace(/^[ \t]{0,3}>[ \t]?/, '')
    return result
  }
  const stripContainers = (line: string) => {
    let result = line
    while (true) {
      const next = stripQuotes(result).replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/, '')
      if (next === result) return result
      result = next
    }
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const plainLines: string[] = []
  let fence: { marker: string; length: number; body: string[] } | null = null
  for (const line of lines) {
    if (fence) {
      const candidate = stripQuotes(line)
      const closingFence = candidate.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)
      if (closingFence && closingFence[1][0] === fence.marker && closingFence[1].length >= fence.length) {
        plainLines.push(protect(fence.body.join('\n')))
        fence = null
      } else {
        fence.body.push(candidate)
      }
      continue
    }

    const normalizedLine = stripContainers(line)
    const openingFence = normalizedLine.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    if (openingFence) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length, body: [] }
      continue
    }
    plainLines.push(normalizedLine)
  }
  if (fence) plainLines.push(protect(fence.body.join('\n')))

  const text = plainLines.join('\n')
    .replace(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<[^>\n]+>|\S+)(?:[ \t]+.*)?$/gm, (_match, label: string) => {
      if (!label.startsWith('^')) references.add(normalizeReference(label))
      return ''
    })
    .replace(/(`+)([\s\S]*?)\1/g, (_match, _fence: string, code: string) => protect(code.replace(/\n/g, ' ')))
    .replace(/^\u3000+/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S.*$/gm, '')
    .replace(/^[ \t]*(?:(?:\*|_|-)[ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*={3,}[ \t]*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '')
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/!\[([^\]]*)\](?!\()/g, (match, label: string) => references.has(normalizeReference(label)) ? label : match)
    .replace(/\[([^\]]+)\](?!\s*\()/g, (match, label: string) => references.has(normalizeReference(label)) ? label : match)
    .replace(/\[[ xX]\][ \t]+/g, '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/~~(.+?)~~/gs, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\\([\\`*_{}()#+.!>\-])/g, '$1')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/^ {0,3}#+[ \t]*$/gm, '')
    .replace(/^[ \t]*\|/gm, '')
    .replace(/\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, '\t')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.replace(/\u0000TEXT(\d+)\u0000/g, (_match, index: string) => protectedSegments[Number(index)] ?? '')
}
