import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatChapterContent, markdownToPlainText, splitChapterParagraphs } from '../src/utils/chapterText.ts'

test('formats paragraph starts while preserving Markdown blocks and fenced code', () => {
  const source = '　旧缩进\r\n续行\r\n\r\n## 标题\r\n\r\n```js\r\n  const value = 1\r\n```\r\n\r\n  普通段落'
  assert.equal(formatChapterContent(source, 2), '　　旧缩进\n续行\n\n## 标题\n\n```js\n  const value = 1\n```\n\n　　普通段落')
})

test('supports zero indentation and preserves indented Markdown code blocks', () => {
  const source = '  普通段落\n\n    const value = 1'
  assert.equal(formatChapterContent(source, 0), '普通段落\n\n    const value = 1')
})

test('splits paragraphs only on blank lines and normalizes line endings', () => {
  assert.deepEqual(splitChapterParagraphs('第一行\r\n续行\r\n \t\r\n第二段\r\n\r\n第三段'), ['第一行\n续行', '第二段', '第三段'])
  assert.deepEqual(splitChapterParagraphs(''), [''])
})

test('removes Markdown formatting while preserving link labels, quote text, and fenced code', () => {
  const markdown = '# 标题\n\n这是 **重点** 和 [链接](https://example.com)。\n\n> - 引用项\n\n```txt\n代码 **原样**\n```'
  assert.equal(markdownToPlainText(markdown), '标题\n\n这是 重点 和 链接。\n\n引用项\n\n代码 **原样**')
})

test('resolves reference links and preserves inline code content', () => {
  const markdown = '使用 `a * b`，查看 [资料][guide]。\n\n[guide]: https://example.com'
  assert.equal(markdownToPlainText(markdown), '使用 a * b，查看 资料。')
})
