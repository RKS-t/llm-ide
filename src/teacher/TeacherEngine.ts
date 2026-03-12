import * as fs from 'fs'
import * as path from 'path'

export interface KnowledgeEntry {
  timestamp: string
  topic: string
  localResponse: string
  claudeFeedback: string
  keyLearnings: string[]
  mistakesToAvoid: string[]   // 반복하면 안 되는 실수 패턴
  tags: string[]              // 주제 태그 (typescript, api, logic 등)
}

export class TeacherEngine {
  private knowledgePath: string
  private learningFilePath: string
  private entries: KnowledgeEntry[]

  constructor(workspacePath: string) {
    this.knowledgePath    = path.join(workspacePath, '.llm-ide-knowledge.json')
    this.learningFilePath = path.join(workspacePath, 'ai-learning.md')
    this.entries = this.load()
  }

  // ── 저장/로드 ──────────────────────────────────────────────────────────────

  private load(): KnowledgeEntry[] {
    try {
      if (fs.existsSync(this.knowledgePath)) {
        const raw = JSON.parse(fs.readFileSync(this.knowledgePath, 'utf-8'))
        // 구 포맷 호환: mistakesToAvoid / tags 없을 수 있음
        return (raw as any[]).map(e => ({
          mistakesToAvoid: [],
          tags: [],
          ...e
        }))
      }
    } catch {}
    return []
  }

  private save() {
    fs.writeFileSync(this.knowledgePath, JSON.stringify(this.entries, null, 2))
  }

  // ── 마크다운 학습 파일 생성 ────────────────────────────────────────────────

  private writeLearningFile() {
    const lines: string[] = [
      '# LLM IDE — AI 학습 기록',
      '',
      '> Claude 선생님의 코드 리뷰를 자동으로 요약한 파일입니다.',
      '> 에이전트는 이 파일을 참고해 같은 실수를 반복하지 않습니다.',
      '',
      `> 마지막 업데이트: ${new Date().toLocaleString('ko-KR')}`,
      '',
      '---',
      '',
    ]

    // ── 최근 주의사항 요약 (상단에 노출) ──────────────────────────────────
    const allMistakes = this.entries.flatMap(e => e.mistakesToAvoid).filter(Boolean)
    if (allMistakes.length > 0) {
      lines.push('## ⚠️ 반복하면 안 되는 실수 패턴')
      lines.push('')
      // 최근 것 우선, 중복 제거
      const seen = new Set<string>()
      const unique = [...allMistakes].reverse().filter(m => {
        const key = m.slice(0, 40)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      unique.slice(0, 10).forEach(m => lines.push(`- ❌ ${m}`))
      lines.push('')
      lines.push('---')
      lines.push('')
    }

    // ── 세션별 상세 기록 ──────────────────────────────────────────────────
    lines.push('## 📚 세션별 학습 기록')
    lines.push('')

    const sorted = [...this.entries].reverse() // 최신 순
    for (const entry of sorted) {
      const date = new Date(entry.timestamp).toLocaleString('ko-KR')
      lines.push(`### ${date}`)
      if (entry.tags.length > 0) {
        lines.push(`> 태그: ${entry.tags.map(t => `\`${t}\``).join(' ')}`)
      }
      lines.push('')
      lines.push(`**주제:** ${entry.topic}`)
      lines.push('')

      if (entry.keyLearnings.length > 0) {
        lines.push('**핵심 학습**')
        entry.keyLearnings.forEach(l => lines.push(`- ✅ ${l}`))
        lines.push('')
      }

      if (entry.mistakesToAvoid.length > 0) {
        lines.push('**주의사항**')
        entry.mistakesToAvoid.forEach(m => lines.push(`- ❌ ${m}`))
        lines.push('')
      }

      lines.push('---')
      lines.push('')
    }

    fs.writeFileSync(this.learningFilePath, lines.join('\n'), 'utf-8')
  }

  // ── 시스템 프롬프트 주입 컨텍스트 ─────────────────────────────────────────

  /**
   * 에이전트/채팅 시스템 프롬프트에 주입할 학습 내용.
   * 현재 질문과 유사한 태그를 우선 반환.
   */
  getKnowledgeContext(currentQuery?: string): string {
    if (this.entries.length === 0) return ''

    // 태그 기반 관련성 정렬
    const scored = this.entries.map(e => {
      let score = 0
      if (currentQuery) {
        const q = currentQuery.toLowerCase()
        e.tags.forEach(t => { if (q.includes(t)) score += 2 })
        if (q.includes(e.topic.slice(0, 20).toLowerCase())) score += 1
      }
      return { entry: e, score }
    })

    scored.sort((a, b) => b.score - a.score || 0)
    const relevant = scored.slice(0, 6).map(s => s.entry)

    const mistakeLines: string[] = []
    const learningLines: string[] = []

    relevant.forEach(e => {
      e.mistakesToAvoid.forEach(m => mistakeLines.push(`- ❌ ${m}`))
      e.keyLearnings.forEach(l => learningLines.push(`- ✅ ${l}`))
    })

    const parts: string[] = []
    parts.push('\n## AI 학습 기록 (과거 Claude 선생님 지도 내용)')

    if (mistakeLines.length > 0) {
      parts.push('\n### 반복하면 안 되는 실수')
      parts.push(mistakeLines.slice(0, 8).join('\n'))
    }
    if (learningLines.length > 0) {
      parts.push('\n### 핵심 원칙')
      parts.push(learningLines.slice(0, 6).join('\n'))
    }
    parts.push('\n> 위 내용을 반드시 숙지하고 같은 실수를 반복하지 마세요.')

    return parts.join('\n')
  }

  getEntries(): KnowledgeEntry[] {
    return [...this.entries]
  }

  getLearningFilePath(): string {
    return this.learningFilePath
  }

  // ── Claude 교수 ────────────────────────────────────────────────────────────

  async teach(
    apiKey: string,
    userQuery: string,
    localResponse: string,
    onChunk: (text: string) => void
  ): Promise<void> {
    const systemPrompt = `당신은 뛰어난 시니어 개발자 멘토입니다. 로컬 AI의 코드 응답을 검토하고 더 나은 방향을 제시합니다.
반드시 한국어로 답변하고, 응답 마지막에 다음 두 섹션을 반드시 포함하세요:

## 핵심 학습
- (기억해야 할 올바른 원칙, 3개 이내)

## 반복하면 안 되는 실수
- (이 응답에서 잘못된 점 / 앞으로 피해야 할 패턴, 3개 이내)`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `[사용자 질문]\n${userQuery}\n\n[로컬 AI 응답]\n${localResponse}\n\n위 응답을 검토하고 개선점을 제시해주세요.`
          }
        ],
        stream: true
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Claude API 오류 (${response.status}): ${errText}`)
    }

    let fullText = ''
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const raw = decoder.decode(value, { stream: true })
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text
            onChunk(parsed.delta.text)
          }
        } catch {}
      }
    }

    const keyLearnings    = this.extractSection(fullText, '핵심 학습')
    const mistakesToAvoid = this.extractSection(fullText, '반복하면 안 되는 실수')
    const tags            = this.extractTags(userQuery + ' ' + fullText)

    this.entries.push({
      timestamp: new Date().toISOString(),
      topic: userQuery.slice(0, 120),
      localResponse: localResponse.slice(0, 600),
      claudeFeedback: fullText.slice(0, 1500),
      keyLearnings,
      mistakesToAvoid,
      tags
    })

    this.save()
    this.writeLearningFile()
  }

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────

  private extractSection(text: string, heading: string): string[] {
    const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=##|$)`)
    const match = text.match(re)
    if (!match) return []
    return match[1]
      .split('\n')
      .filter(l => l.trim().match(/^[-*•]/))
      .map(l => l.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
  }

  private extractTags(text: string): string[] {
    const TAG_KEYWORDS: Record<string, string[]> = {
      typescript:  ['typescript', 'ts', '타입스크립트', 'interface', 'type alias', 'generic'],
      javascript:  ['javascript', 'js', '자바스크립트', 'async', 'promise', 'closure'],
      python:      ['python', '파이썬', 'django', 'flask', 'fastapi'],
      react:       ['react', 'jsx', 'tsx', 'hook', 'component', '컴포넌트'],
      api:         ['api', 'rest', 'http', 'fetch', 'axios', 'endpoint'],
      database:    ['sql', 'database', 'db', 'query', '데이터베이스'],
      testing:     ['test', 'jest', 'spec', '테스트', 'mock'],
      performance: ['performance', '성능', 'optimize', '최적화', 'memory'],
      security:    ['security', '보안', 'auth', 'jwt', 'xss', 'injection'],
      logic:       ['logic', '로직', 'algorithm', '알고리즘', 'bug', '버그'],
    }
    const lower = text.toLowerCase()
    return Object.entries(TAG_KEYWORDS)
      .filter(([, kws]) => kws.some(kw => lower.includes(kw)))
      .map(([tag]) => tag)
  }
}
