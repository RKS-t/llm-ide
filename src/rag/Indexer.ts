import * as fs from 'fs'
import * as path from 'path'

export interface CodeChunk {
  file: string
  content: string
  startLine: number
  embedding?: number[]
}

export class Indexer {
  private indexPath: string
  private chunks: CodeChunk[] = []

  private readonly SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx',
    '.java', '.kt', '.py', '.go',
    '.rs', '.cpp', '.c', '.h',
    '.md', '.json', '.yaml', '.yml'
  ]

  private readonly IGNORE_DIRS = [
    'node_modules', '.git', 'out', 'dist',
    'build', '.idea', '.vscode', 'target'
  ]

  constructor(workspacePath: string) {
    this.indexPath = path.join(workspacePath, '.llm-ide-index.json')
  }

  async buildIndex(workspacePath: string): Promise<void> {
    console.log('인덱싱 시작...')
    this.chunks = []

    const files = this.collectFiles(workspacePath)
    console.log(`파일 ${files.length}개 발견`)

    for (const file of files) {
      const fileChunks = this.parseFile(file, workspacePath)
      for (const chunk of fileChunks) {
        try {
          chunk.embedding = await this.embed(chunk.content)
          this.chunks.push(chunk)
        } catch (e) {
          // 단일 청크 embed 실패는 건너뛰고 계속 진행
          console.warn(`embed 실패 (건너뜀): ${chunk.file} line ${chunk.startLine}`, e)
        }
      }
    }

    fs.writeFileSync(this.indexPath, JSON.stringify(this.chunks, null, 2))
    console.log(`인덱싱 완료: ${this.chunks.length}개 청크`)
  }

  loadIndex(): boolean {
    try {
      if (fs.existsSync(this.indexPath)) {
        this.chunks = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
        return true
      }
    } catch (e) {
      console.error('인덱스 로드 실패:', e)
    }
    return false
  }

  getChunks(): CodeChunk[] {
    return this.chunks
  }

  private collectFiles(dirPath: string): string[] {
    const files: string[] = []

    const scan = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (this.IGNORE_DIRS.includes(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scan(fullPath)
        } else if (this.SUPPORTED_EXTENSIONS.includes(path.extname(entry.name))) {
          files.push(fullPath)
        }
      }
    }

    scan(dirPath)
    return files
  }

  private parseFile(filePath: string, workspacePath: string): CodeChunk[] {
    const chunks: CodeChunk[] = []
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const relativePath = path.relative(workspacePath, filePath)
      const ext = path.extname(filePath)
      const lines = content.split('\n')

      // 80줄 이하 소형 파일은 통째로 하나의 청크
      if (lines.length <= 80) {
        chunks.push({
          file: relativePath,
          content: `// 파일: ${relativePath}\n${content.trim()}`,
          startLine: 1
        })
        return chunks
      }

      // Java / Kotlin: 메서드/클래스 단위 청킹
      if (['.java', '.kt'].includes(ext)) {
        return this.parseByMethod(content, relativePath)
      }

      // 그 외: 80줄 / 20줄 오버랩 청킹
      const CHUNK_SIZE = 80
      const OVERLAP = 20
      for (let i = 0; i < lines.length; i += CHUNK_SIZE - OVERLAP) {
        const chunkLines = lines.slice(i, i + CHUNK_SIZE)
        const chunkContent = chunkLines.join('\n').trim()
        if (chunkContent.length < 10) continue
        chunks.push({
          file: relativePath,
          content: `// 파일: ${relativePath} (${i + 1}~${i + chunkLines.length}줄)\n${chunkContent}`,
          startLine: i + 1
        })
      }
    } catch (e) {
      console.error(`파일 파싱 실패: ${filePath}`)
    }
    return chunks
  }

  private parseByMethod(content: string, relativePath: string): CodeChunk[] {
    const chunks: CodeChunk[] = []
    const lines = content.split('\n')
    const METHOD_PATTERN = /^\s*(public|private|protected|static|class|fun|suspend|override|abstract)\b/
    let methodStart = -1
    let braceDepth = 0
    let buffer: string[] = []

    const flush = () => {
      if (buffer.length > 0) {
        chunks.push({
          file: relativePath,
          content: `// 파일: ${relativePath} (${methodStart + 1}줄)\n${buffer.join('\n').trim()}`,
          startLine: methodStart + 1
        })
      }
      methodStart = -1
      buffer = []
      braceDepth = 0
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (methodStart === -1 && METHOD_PATTERN.test(line)) {
        methodStart = i
        braceDepth = 0
        buffer = []
      }

      if (methodStart !== -1) {
        buffer.push(line)
        braceDepth += (line.match(/{/g) ?? []).length
        braceDepth -= (line.match(/}/g) ?? []).length

        // 청크가 너무 커지면 강제로 자르기
        if (buffer.length >= 120) flush()
        else if (braceDepth <= 0 && buffer.length > 1) flush()
        else if (braceDepth <= 0 && buffer.length === 1) {
          // 단일 라인 선언 (expression body 등)
          flush()
        }
      }
    }
    // 남은 버퍼 처리
    if (buffer.length > 0) flush()

    // 메서드 파싱 결과가 없으면 일반 청킹으로 폴백
    if (chunks.length === 0) {
      const CHUNK_SIZE = 80
      const OVERLAP = 20
      for (let i = 0; i < lines.length; i += CHUNK_SIZE - OVERLAP) {
        const chunkContent = lines.slice(i, i + CHUNK_SIZE).join('\n').trim()
        if (chunkContent.length < 10) continue
        chunks.push({ file: relativePath, content: `// 파일: ${relativePath} (${i + 1}줄~)\n${chunkContent}`, startLine: i + 1 })
      }
    }
    return chunks
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nomic-embed-text',
        input: text
      })
    })
    if (!response.ok) {
      throw new Error(`embed API 오류: ${response.status}`)
    }
    const data: any = await response.json()
    const vec = data.embeddings?.[0]
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('embed 응답이 비어있음')
    }
    return vec
  }
}