// Tests for src/result.tsx pure logic. SpecMarkdown carries pure block→markdown
// logic and is exercised by calling it as a plain function (no rendering).
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { SpecBlock } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {},
}))

import { SpecMarkdown, Markdown, ext, fileKind } from '../src/result'

const mdOf = (blocks: SpecBlock[]): string => {
  const el = SpecMarkdown({ blocks }) as React.ReactElement
  expect(el.type).toBe(Markdown)
  return (el.props as { text: string }).text
}

describe('SpecMarkdown block → markdown', () => {
  it('prefixes h1/h2/li and separates blocks with blank lines', () => {
    expect(mdOf([
      { k: 'h1', text: 'Title' },
      { k: 'p', text: 'para' },
      { k: 'h2', text: 'Sec' },
    ])).toBe('# Title\n\npara\n\n## Sec')
  })
  it('adjacent li stay one list (single newline), non-adjacent separate', () => {
    expect(mdOf([
      { k: 'h1', text: 'T' },
      { k: 'li', text: 'a' },
      { k: 'li', text: 'b' },
      { k: 'p', text: 'x' },
      { k: 'li', text: 'c' },
    ])).toBe('# T\n\n- a\n- b\n\nx\n\n- c')
  })
})

describe('ext / fileKind', () => {
  it('ext lowercases the last extension; no dot → empty string', () => {
    expect(ext('report.MD')).toBe('md')
    expect(ext('archive.tar.GZ')).toBe('gz')
    expect(ext('noext')).toBe('')
    expect(ext('trailing.')).toBe('')
  })
  it('fileKind maps md/html/img families case-insensitively, unknown → null', () => {
    expect(fileKind('a.md')).toBe('md')
    expect(fileKind('a.MARKDOWN')).toBe('md')
    expect(fileKind('a.html')).toBe('html')
    expect(fileKind('a.htm')).toBe('html')
    for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'SVG']) expect(fileKind(`a.${e}`)).toBe('img')
    expect(fileKind('a.txt')).toBeNull()
    expect(fileKind('noext')).toBeNull()
  })
})
