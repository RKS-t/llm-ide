import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

export interface ToolResult {
  success: boolean
  output: string
}

export class Tools {

  static getWorkspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  }

  static resolvePath(filePath: string): string {
    let clean = filePath
      .replace(/\.git$/i, '')
      .replace(/\\/g, '/')
      .trim()

    if (clean.includes('/.git') || clean === '.git') {
      throw new Error(`.git 디렉토리 접근 차단: ${filePath}`)
    }

    return path.isAbsolute(clean)
      ? clean
      : path.join(this.getWorkspacePath(), clean)
  }

  static readFile(filePath: string): ToolResult {
    try {
      const fullPath = this.resolvePath(filePath)
      const content = fs.readFileSync(fullPath, 'utf-8')
      return { success: true, output: content }
    } catch (e: any) {
      return { success: false, output: `파일 읽기 실패: ${e.message}` }
    }
  }

  static backupFile(filePath: string): ToolResult {
    try {
      const fullPath = this.resolvePath(filePath)
      if (!fs.existsSync(fullPath)) {
        return { success: true, output: '백업 불필요 (파일 없음)' }
      }
      const backupDir = path.join(this.getWorkspacePath(), '.llm-ide-backup')
      fs.mkdirSync(backupDir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupName = path.basename(filePath) + '.' + timestamp + '.bak'
      fs.copyFileSync(fullPath, path.join(backupDir, backupName))
      return { success: true, output: `백업 완료: .llm-ide-backup/${backupName}` }
    } catch (e: any) {
      return { success: false, output: `백업 실패: ${e.message}` }
    }
  }

  static writeFile(filePath: string, content: string): ToolResult {
    try {
      const fullPath = this.resolvePath(filePath)
      if (fs.existsSync(fullPath)) this.backupFile(filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content, 'utf-8')
      return { success: true, output: `파일 저장 완료: ${filePath}` }
    } catch (e: any) {
      return { success: false, output: `파일 저장 실패: ${e.message}` }
    }
  }

  static editFile(filePath: string, oldStr: string, newStr: string): ToolResult {
    try {
      const fullPath = this.resolvePath(filePath)
      const content = fs.readFileSync(fullPath, 'utf-8')
      if (!content.includes(oldStr)) {
        return { success: false, output: `원본 코드를 찾을 수 없습니다.\n찾으려 한 코드:\n${oldStr}` }
      }
      this.backupFile(filePath)
      const updated = content.replace(oldStr, newStr)
      fs.writeFileSync(fullPath, updated, 'utf-8')
      return { success: true, output: `파일 수정 완료: ${filePath}` }
    } catch (e: any) {
      return { success: false, output: `파일 수정 실패: ${e.message}` }
    }
  }

  static deleteFile(filePath: string): ToolResult {
    try {
      const fullPath = this.resolvePath(filePath)
      if (!fs.existsSync(fullPath)) {
        return { success: false, output: `파일이 존재하지 않습니다: ${filePath}` }
      }
      fs.rmSync(fullPath, { recursive: true, force: true })
      return { success: true, output: `삭제 완료: ${filePath}` }
    } catch (e: any) {
      return { success: false, output: `삭제 실패: ${e.message}` }
    }
  }

  static listFiles(dirPath: string = ''): ToolResult {
    const IGNORE = ['node_modules', '.git', 'out', 'dist', 'build', 'target', '.idea', '.vscode']
    try {
      const rootPath = dirPath ? this.resolvePath(dirPath) : this.getWorkspacePath()
      const lines: string[] = [path.basename(rootPath) + '/']

      const scan = (dir: string, prefix: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !IGNORE.includes(e.name))
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        entries.forEach((entry, idx) => {
          const last = idx === entries.length - 1
          lines.push(prefix + (last ? '└── ' : '├── ') + entry.name)
          if (entry.isDirectory()) {
            scan(path.join(dir, entry.name), prefix + (last ? '    ' : '│   '))
          }
        })
      }

      scan(rootPath, '')
      return { success: true, output: lines.join('\n') }
    } catch (e: any) {
      return { success: false, output: `목록 조회 실패: ${e.message}` }
    }
  }

  static searchInFiles(pattern: string, dir: string = ''): ToolResult {
    const IGNORE = ['node_modules', '.git', 'out', 'dist', 'build', 'target']
    const SUPPORTED = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml', '.py', '.go', '.rs', '.java', '.kt', '.cpp', '.c', '.h']
    try {
      const rootPath = dir ? this.resolvePath(dir) : this.getWorkspacePath()
      const results: string[] = []
      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'gi')
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      }

      const search = (dirPath: string) => {
        if (results.length >= 300) return
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          if (IGNORE.includes(entry.name)) continue
          const fullPath = path.join(dirPath, entry.name)
          if (entry.isDirectory()) {
            search(fullPath)
          } else if (SUPPORTED.includes(path.extname(entry.name))) {
            try {
              const lines = fs.readFileSync(fullPath, 'utf-8').split('\n')
              const relPath = path.relative(this.getWorkspacePath(), fullPath)
              lines.forEach((line, idx) => {
                regex.lastIndex = 0
                if (regex.test(line)) {
                  results.push(`${relPath}:${idx + 1}:  ${line.trim()}`)
                }
              })
            } catch {}
          }
        }
      }

      search(rootPath)
      if (results.length === 0) return { success: true, output: '일치하는 결과 없음' }
      const output = results.slice(0, 300).join('\n')
      return { success: true, output: results.length >= 300 ? output + '\n... (결과 300개에서 잘림)' : output }
    } catch (e: any) {
      return { success: false, output: `검색 실패: ${e.message}` }
    }
  }

  static runDiagnostics(): ToolResult {
    try {
      const workspacePath = this.getWorkspacePath()
      let output = ''
      try {
        output = execSync('npx tsc --noEmit 2>&1', {
          cwd: workspacePath,
          timeout: 30000,
          encoding: 'utf-8'
        })
      } catch (e: any) {
        output = e.stdout ?? e.message ?? ''
      }
      return { success: true, output: output.trim() || '✅ 타입 오류 없음' }
    } catch (e: any) {
      return { success: false, output: `진단 실패: ${e.message}` }
    }
  }

  static runCommand(command: string, cwd: string = ''): ToolResult {
    try {
      const workDir = cwd ? this.resolvePath(cwd) : this.getWorkspacePath()
      const output = execSync(command, {
        cwd: workDir,
        timeout: 60000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const trimmed = output.trim()
      return { success: true, output: trimmed.slice(0, 10000) || '(출력 없음)' }
    } catch (e: any) {
      const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim() || e.message
      return { success: false, output: out.slice(0, 10000) }
    }
  }

  static gitStatus(): ToolResult {
    return this.runCommand('git status --short')
  }

  static gitDiff(file: string = ''): ToolResult {
    const cmd = file ? `git diff -- "${file}"` : 'git diff'
    return this.runCommand(cmd)
  }

  static gitCommit(message: string): ToolResult {
    const safe = message.replace(/"/g, '\\"')
    return this.runCommand(`git add -A && git commit -m "${safe}"`)
  }

  static gitPush(): ToolResult {
    return this.runCommand('git push')
  }

  static gitLog(n: number = 10): ToolResult {
    return this.runCommand(`git log --oneline -${n}`)
  }

  static moveFile(srcPath: string, destPath: string): ToolResult {
    try {
      const fullSrc = this.resolvePath(srcPath)
      const fullDest = this.resolvePath(destPath)
      if (!fs.existsSync(fullSrc)) {
        return { success: false, output: `원본 파일이 존재하지 않습니다: ${srcPath}` }
      }
      fs.mkdirSync(path.dirname(fullDest), { recursive: true })
      fs.renameSync(fullSrc, fullDest)
      return { success: true, output: `이동 완료: ${srcPath} → ${destPath}` }
    } catch (e: any) {
      return { success: false, output: `이동 실패: ${e.message}` }
    }
  }
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '파일 내용을 읽습니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '읽을 파일 경로 (프로젝트 루트 기준 상대경로)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '파일을 생성하거나 전체 내용을 씁니다. 없는 디렉토리도 자동 생성합니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로' },
          content: { type: 'string', description: '파일 전체 내용' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '파일의 특정 부분만 수정합니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로' },
          old_str: { type: 'string', description: '수정할 기존 코드 (정확히 일치해야 함)' },
          new_str: { type: 'string', description: '새로 대체할 코드' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '파일 또는 디렉토리를 삭제합니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '삭제할 파일 또는 디렉토리 경로' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: '파일을 다른 경로로 이동하거나 이름을 변경합니다.',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '원본 파일 경로' },
          dest: { type: 'string', description: '대상 파일 경로' }
        },
        required: ['src', 'dest']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '디렉토리의 전체 파일 트리를 재귀적으로 조회합니다. 프로젝트 구조를 파악할 때 사용하세요.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '조회할 디렉토리 경로 (기본: 프로젝트 루트)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_in_files',
      description: '프로젝트 파일 전체에서 텍스트나 정규식 패턴을 검색합니다. 심볼 사용처, import 관계, 특정 코드 위치 파악에 사용하세요.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '검색할 텍스트 또는 정규식 패턴' },
          path: { type: 'string', description: '검색 범위 디렉토리 (기본: 프로젝트 전체)' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_diagnostics',
      description: 'TypeScript 컴파일러(tsc)를 실행해 프로젝트 전체의 타입 오류를 확인합니다. 파일 수정 후 반드시 호출해서 오류가 없는지 검증하세요.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '터미널 명령을 실행합니다. 빌드(npm run build), 테스트(npm test), 스크립트 실행 등에 사용하세요.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '실행할 셸 명령' },
          path: { type: 'string', description: '명령을 실행할 디렉토리 (기본: 프로젝트 루트)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '현재 Git 작업 디렉토리의 변경 상태를 확인합니다.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '변경된 파일의 diff를 확인합니다.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '특정 파일만 확인할 경우 경로 (기본: 전체)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: '변경된 모든 파일을 스테이징하고 커밋합니다.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '커밋 메시지' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: '현재 브랜치를 원격 저장소에 푸시합니다.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: '최근 커밋 로그를 확인합니다.',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'number', description: '조회할 커밋 수 (기본: 10)' }
        },
        required: []
      }
    }
  }
]