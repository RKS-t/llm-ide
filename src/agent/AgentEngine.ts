import { Tools, TOOL_DEFINITIONS, ToolResult } from './tools'

export interface AgentEvent {
  type: 'tool_call' | 'tool_result' | 'stream_chunk' | 'done' | 'error'
  content: string
}

export class AgentEngine {
  private model: string
  private knowledgeContext: string
  private onEvent: (event: AgentEvent) => void

  constructor(model: string, knowledgeContext: string, onEvent: (event: AgentEvent) => void) {
    this.model = model
    this.knowledgeContext = knowledgeContext
    this.onEvent = onEvent
  }

  async run(userMessage: string, fileContext: string): Promise<void> {
    const messages: any[] = [
      {
        role: 'system',
        content: `You are an AI Agent that helps with code tasks in a VS Code extension.
You MUST use tools to complete every task. Never answer with text alone.

## Workflow Rules
1. Start with list_files to understand the full project structure
2. Use search_in_files to find where symbols, functions, types, or imports are used
3. Read ALL files that could be affected before making any changes
4. When editing, check for callers/dependents with search_in_files to avoid breaking other code
5. After all edits, call run_diagnostics to verify there are no TypeScript errors
6. If run_diagnostics reports errors, fix them before reporting done
7. Use run_command for build/test/script execution
8. Use git_status / git_diff / git_commit / git_push for Git operations
9. AUTO ERROR FIX: run_command 실패 시 반드시:
   a. 에러 메시지를 꼼꼼히 읽기
   b. search_in_files 또는 read_file 로 관련 소스 파일 찾기
   c. edit_file 로 에러 수정
   d. run_command 재실행으로 수정 확인
   e. 빌드/테스트가 통과할 때까지 반복
   f. 절대 포기하지 말 것 — 반드시 자동으로 고칠 것

## Tool Usage Guide
- list_files: Full recursive file tree
- search_in_files: Find any text/regex across all source files
- read_file / write_file / edit_file / delete_file / move_file: File operations
- run_diagnostics: tsc --noEmit type check
- run_command: Run any terminal command (npm run build, pytest, etc.)
- git_status / git_diff / git_log / git_commit / git_push: Git operations

IMPORTANT: Respond and explain everything in Korean only.
${this.knowledgeContext}
${fileContext ? '\nCurrently open file (reference only):\n' + fileContext : ''}`
      },
      { role: 'user', content: userMessage }
    ]

    for (let step = 0; step < 15; step++) {
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: TOOL_DEFINITIONS,
          stream: false,
          options: { num_ctx: 8192 }
        })
      })

      const data: any = await response.json()
      const assistantMsg = data.message
      const toolCalls = this.extractToolCalls(assistantMsg)

      if (!toolCalls || toolCalls.length === 0) {
        // 최종 응답을 단어 단위로 스트리밍
        await this.streamText(assistantMsg.content || '작업 완료')
        this.onEvent({ type: 'done', content: '' })
        break
      }

      messages.push(assistantMsg)

      for (const toolCall of toolCalls) {
        const { name, args } = toolCall

        this.onEvent({
          type: 'tool_call',
          content: `🔧 ${name}(${JSON.stringify(args)})`
        })

        const result = this.executeTool(name, args)

        this.onEvent({
          type: 'tool_result',
          content: result.success ? `✅ ${result.output}` : `❌ ${result.output}`
        })

        messages.push({
          role: 'tool',
          content: result.output
        })
      }
    }
  }

  /** 최종 텍스트를 단어 단위로 스트리밍 (타이핑 효과) */
  private async streamText(text: string): Promise<void> {
    const tokens = text.split(/(\s+)/)
    for (const token of tokens) {
      this.onEvent({ type: 'stream_chunk', content: token })
      await new Promise(r => setTimeout(r, 18))
    }
  }

  private extractToolCalls(msg: any): { name: string; args: any }[] {
    if (!msg) return []

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return msg.tool_calls.map((tc: any) => ({
        name: tc.function?.name ?? tc.name,
        args: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments ?? tc.arguments ?? {})
      }))
    }

    if (msg.content && typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content)
        if (parsed.name && parsed.arguments) {
          return [{ name: parsed.name, args: parsed.arguments }]
        }
      } catch {}
    }

    return []
  }

  private executeTool(name: string, args: any): ToolResult {
    switch (name) {
      case 'read_file':        return Tools.readFile(args.path)
      case 'write_file':       return Tools.writeFile(args.path, args.content)
      case 'edit_file':        return Tools.editFile(args.path, args.old_str, args.new_str)
      case 'delete_file':      return Tools.deleteFile(args.path)
      case 'move_file':        return Tools.moveFile(args.src, args.dest)
      case 'list_files':       return Tools.listFiles(args.path ?? '')
      case 'search_in_files':  return Tools.searchInFiles(args.pattern, args.path ?? '')
      case 'run_diagnostics':  return Tools.runDiagnostics()
      case 'run_command':      return Tools.runCommand(args.command, args.path ?? '')
      case 'git_status':       return Tools.gitStatus()
      case 'git_diff':         return Tools.gitDiff(args.file ?? '')
      case 'git_commit':       return Tools.gitCommit(args.message)
      case 'git_push':         return Tools.gitPush()
      case 'git_log':          return Tools.gitLog(args.n ?? 10)
      default:                 return { success: false, output: `알 수 없는 툴: ${name}` }
    }
  }
}
