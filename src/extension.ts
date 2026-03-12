import * as vscode from 'vscode'
import { AgentEngine } from './agent/AgentEngine'
import { Indexer } from './rag/Indexer'
import { Retriever } from './rag/Retriever'
import { TeacherEngine } from './teacher/TeacherEngine'
import { Tools } from './agent/tools'

export function activate(context: vscode.ExtensionContext) {
  console.log('LLM IDE activated')

  // 워크스페이스에 저장된 인덱스가 있으면 자동 로드
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspacePath) {
    const indexer = new Indexer(workspacePath)
    if (indexer.loadIndex()) {
      ChatPanelProvider.setIndexer(indexer)
      console.log('LLM IDE: 기존 RAG 인덱스 로드 완료')
    }
  }

  const provider = new ChatPanelProvider(context.extensionUri, context)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('llm-ide.chatPanel', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('llm-ide.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.llm-ide-sidebar')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('llm-ide.fixBuildError', () => {
      vscode.commands.executeCommand('workbench.view.extension.llm-ide-sidebar')
      provider.sendAutoFix()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('llm-ide.buildIndex', async () => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!workspacePath) {
        vscode.window.showErrorMessage('먼저 폴더를 열어주세요.')
        return
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '코드 인덱싱 중...', cancellable: false },
        async () => {
          const indexer = new Indexer(workspacePath)
          await indexer.buildIndex(workspacePath)
          ChatPanelProvider.setIndexer(indexer)
          vscode.window.showInformationMessage('✅ 인덱싱 완료!')
        }
      )
    })
  )
}

class ChatPanelProvider implements vscode.WebviewViewProvider {
  private static indexer: Indexer | null = null
  private webviewView: vscode.WebviewView | null = null

  static setIndexer(indexer: Indexer) {
    ChatPanelProvider.indexer = indexer
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {}

  private getLocalModel(): string {
    return vscode.workspace.getConfiguration('llm-ide').get<string>('localModel', 'qwen2.5-coder:32b')
  }

  private getWorkspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
  }

  private getTeacherEngine(): TeacherEngine | null {
    const wp = this.getWorkspacePath()
    return wp ? new TeacherEngine(wp) : null
  }

  sendAutoFix() {
    this.webviewView?.webview.postMessage({ type: 'auto_fix_request', text: '빌드 에러를 자동으로 분석하고 수정해줘' })
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    }
    webviewView.webview.html = this.getHtml()

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'chat':
          await this.handleChat(msg)
          break
        case 'git':
          await this.handleGit(msg)
          break
        case 'settings_save':
          await this.handleSettingsSave(msg)
          break
        case 'settings_load':
          await this.handleSettingsLoad()
          break
      }
    })
  }

  // ── Chat Handler ────────────────────────────────────────────────────────────

  private async handleChat(msg: any) {
    const wv = this.webviewView!
    const model = this.getLocalModel()

    const editor = vscode.window.activeTextEditor
    let fileContext = editor
      ? '현재 파일: ' + editor.document.fileName + '\n' + editor.document.getText()
      : ''

    if (ChatPanelProvider.indexer) {
      const retriever = new Retriever(ChatPanelProvider.indexer)
      const chunks = await retriever.search(msg.text, 5)
      if (chunks.length > 0) {
        fileContext += '\n\n관련 코드:\n' + chunks.map(c => c.content).join('\n\n---\n\n')
      }
    }

    const teacher = this.getTeacherEngine()
    const knowledgeContext = teacher?.getKnowledgeContext(msg.text) ?? ''

    if (msg.agentMode) {
      // ── Agent mode ──────────────────────────────────────────────────────────
      const engine = new AgentEngine(model, knowledgeContext, (event) => {
        if (event.type === 'stream_chunk') {
          wv.webview.postMessage({ type: 'stream_chunk', text: event.content })
        } else if (event.type === 'done') {
          wv.webview.postMessage({ type: 'agent_done' })
        } else {
          wv.webview.postMessage({ type: 'agent_event', text: event.content })
        }
      })

      try {
        await engine.run(msg.text, fileContext)
      } catch (e: any) {
        wv.webview.postMessage({ type: 'agent_done', error: '❌ Agent 오류: ' + e.message })
      }

    } else {
      // ── Chat mode (real streaming) ──────────────────────────────────────────
      try {
        const systemContent = `당신은 코드 작성을 돕는 AI입니다.${knowledgeContext}\n${fileContext}`
        const response = await fetch('http://localhost:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: msg.text }
            ],
            stream: true,
            options: { num_ctx: 8192 }
          })
        })

        let fullResponse = ''
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const raw = decoder.decode(value, { stream: true })
          for (const line of raw.split('\n').filter(l => l.trim())) {
            try {
              const data = JSON.parse(line)
              if (data.message?.content) {
                fullResponse += data.message.content
                wv.webview.postMessage({ type: 'stream_chunk', text: data.message.content })
              }
            } catch {}
          }
        }

        wv.webview.postMessage({ type: 'stream_done' })

        // Teacher mode — 항상 teacher_done을 전송해야 프론트 setBusy(false) 보장
        if (msg.teacherMode) {
          if (!teacher) {
            wv.webview.postMessage({ type: 'teacher_chunk', text: '⚠️ 워크스페이스를 먼저 열어주세요.' })
            wv.webview.postMessage({ type: 'teacher_done' })
          } else {
            const apiKey = await this.context.secrets.get('claudeApiKey') ?? ''
            if (!apiKey) {
              wv.webview.postMessage({ type: 'teacher_chunk', text: '⚠️ Claude API 키가 설정되지 않았습니다. 설정 탭에서 입력하세요.' })
              wv.webview.postMessage({ type: 'teacher_done' })
            } else {
              try {
                await teacher.teach(apiKey, msg.text, fullResponse, (chunk) => {
                  wv.webview.postMessage({ type: 'teacher_chunk', text: chunk })
                })
              } catch (e: any) {
                wv.webview.postMessage({ type: 'teacher_chunk', text: '❌ Claude 오류: ' + e.message })
              } finally {
                wv.webview.postMessage({ type: 'teacher_done' })
              }
            }
          }
        }

      } catch {
        wv.webview.postMessage({ type: 'stream_chunk', text: '❌ Ollama 연결 실패. ollama가 실행 중인지 확인하세요.' })
        wv.webview.postMessage({ type: 'stream_done' })
      }
    }
  }

  // ── Git Handler ─────────────────────────────────────────────────────────────

  private async handleGit(msg: any) {
    const wv = this.webviewView!
    let result: { success: boolean; output: string }

    switch (msg.action) {
      case 'status': result = Tools.gitStatus(); break
      case 'diff':   result = Tools.gitDiff(msg.file ?? ''); break
      case 'log':    result = Tools.gitLog(20); break
      case 'commit': result = Tools.gitCommit(msg.commitMsg ?? 'Update'); break
      case 'push':   result = Tools.gitPush(); break
      default: result = { success: false, output: '알 수 없는 Git 동작' }
    }

    wv.webview.postMessage({ type: 'git_result', action: msg.action, text: result.output, success: result.success })
  }

  // ── Settings Handlers ────────────────────────────────────────────────────────

  private async handleSettingsSave(msg: any) {
    const wv = this.webviewView!
    if (msg.claudeApiKey !== undefined) {
      await this.context.secrets.store('claudeApiKey', msg.claudeApiKey)
    }
    if (msg.localModel) {
      await vscode.workspace.getConfiguration('llm-ide').update('localModel', msg.localModel, vscode.ConfigurationTarget.Global)
    }
    wv.webview.postMessage({ type: 'settings_saved' })
  }

  private async handleSettingsLoad() {
    const wv = this.webviewView!
    const claudeApiKey = await this.context.secrets.get('claudeApiKey') ?? ''
    const localModel = this.getLocalModel()
    wv.webview.postMessage({ type: 'settings', claudeApiKey: claudeApiKey ? '••••••••' : '', localModel })
  }

  // ── HTML ─────────────────────────────────────────────────────────────────────

  private generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let nonce = ''
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return nonce
  }

  private getHtml(): string {
    const nonce = this.generateNonce()
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; connect-src http://localhost:11434 https://api.anthropic.com; font-src https://cdnjs.cloudflare.com;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  background: var(--vscode-sideBar-background);
  color: var(--vscode-foreground);
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

/* ── Tabs ── */
#tabs {
  display: flex;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorGroupHeader-tabsBackground);
  flex-shrink: 0;
}
.tab-btn {
  flex: 1;
  padding: 8px 4px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 15px;
  transition: all 0.15s;
}
.tab-btn.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }

/* ── Panels ── */
.panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.panel.active { display: flex; }

/* ── Chat panel ── */
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg {
  padding: 8px 11px;
  border-radius: 8px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.user {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  align-self: flex-end;
  max-width: 86%;
}
.assistant {
  background: var(--vscode-input-background);
  align-self: flex-start;
  max-width: 96%;
}
.teacher {
  background: #1a3a1a;
  border-left: 3px solid #4caf50;
  align-self: flex-start;
  max-width: 96%;
  font-size: 12px;
}
.agent-event {
  background: none;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  padding: 2px 8px;
  align-self: flex-start;
}
.loading { opacity: 0.55; font-style: italic; }
.msg pre { background: #1e1e1e; border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 6px 0; }
.msg pre code { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.msg code:not(pre code) { background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.msg p { margin: 4px 0; }
.msg ul, .msg ol { padding-left: 18px; margin: 4px 0; }
.msg strong { font-weight: 700; }
.msg em { font-style: italic; }

#mode-bar {
  display: flex;
  gap: 6px;
  padding: 6px 10px 4px;
  flex-shrink: 0;
}
.mode-btn {
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
  transition: all 0.15s;
}
.mode-btn.on { background: #f59e0b; color: #000; border-color: #f59e0b; }
.mode-btn.teacher-on { background: #4caf50; color: #000; border-color: #4caf50; }

#input-area {
  padding: 8px 10px;
  border-top: 1px solid var(--vscode-panel-border);
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
#input {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 120px;
  font-family: inherit;
}
.send-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
}
.send-btn:hover { background: var(--vscode-button-hoverBackground); }
.send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* ── Git panel ── */
#git-toolbar {
  display: flex;
  gap: 5px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.git-btn {
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
}
.git-btn:hover { background: var(--vscode-list-hoverBackground); }
#git-output {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vscode-foreground);
}
#commit-area {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
#commit-msg {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  resize: none;
  min-height: 32px;
  font-family: inherit;
}
#do-commit {
  background: #4caf50;
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

/* ── Settings panel ── */
#settings-panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}
.setting-group label {
  display: block;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.setting-group input {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 13px;
  outline: none;
}
.setting-group input:focus { border-color: var(--vscode-focusBorder); }
#save-settings {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 7px 16px;
  cursor: pointer;
  font-size: 13px;
  align-self: flex-start;
}
#save-settings:hover { background: var(--vscode-button-hoverBackground); }
#settings-status { font-size: 12px; color: #4caf50; }
.knowledge-entry {
  background: var(--vscode-input-background);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  border-left: 3px solid #4caf50;
}
.knowledge-entry .topic { font-weight: 600; margin-bottom: 4px; }
.knowledge-entry .learnings { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<!-- ── Tab Navigation ── -->
<nav id="tabs">
  <button class="tab-btn active" data-tab="chat">💬 채팅</button>
  <button class="tab-btn" data-tab="git">🌿 Git</button>
  <button class="tab-btn" data-tab="settings">⚙️ 설정</button>
</nav>

<!-- ── Chat Panel ── -->
<div id="panel-chat" class="panel active">
  <div id="messages">
    <div class="msg assistant">안녕하세요! LLM IDE입니다. 코드에 대해 무엇이든 물어보세요.<br><small style="opacity:0.6">💬 Chat | 🤖 Agent | 🎓 Teacher 모드를 선택할 수 있습니다.</small></div>
  </div>
  <div id="mode-bar">
    <button class="mode-btn" id="agent-btn">🤖 Agent</button>
    <button class="mode-btn" id="teacher-btn">🎓 Teacher</button>
  </div>
  <div id="input-area">
    <textarea id="input" placeholder="메시지 입력… (Enter 전송, Shift+Enter 줄바꿈)" rows="1"></textarea>
    <button class="send-btn" id="send">전송</button>
  </div>
</div>

<!-- ── Git Panel ── -->
<div id="panel-git" class="panel">
  <div id="git-toolbar">
    <button class="git-btn" data-action="status">📋 Status</button>
    <button class="git-btn" data-action="diff">🔍 Diff</button>
    <button class="git-btn" data-action="log">📜 Log</button>
    <button class="git-btn" data-action="push">🚀 Push</button>
  </div>
  <pre id="git-output">(Status, Diff, Log 버튼으로 Git 정보를 확인하세요)</pre>
  <div id="commit-area">
    <textarea id="commit-msg" placeholder="커밋 메시지…" rows="1"></textarea>
    <button id="do-commit">✅ 커밋</button>
  </div>
</div>

<!-- ── Settings Panel ── -->
<div id="panel-settings" class="panel">
  <div id="settings-panel">
    <div class="setting-group">
      <label>Claude API Key (Teacher 기능)</label>
      <input type="password" id="claude-key" placeholder="sk-ant-api03-...">
    </div>
    <div class="setting-group">
      <label>로컬 모델 (Ollama)</label>
      <input type="text" id="local-model" placeholder="qwen2.5-coder:32b">
    </div>
    <button id="save-settings">저장</button>
    <p id="settings-status"></p>
    <div id="knowledge-list" style="display:flex;flex-direction:column;gap:8px;"></div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi()

// ── Tab switching ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('panel-' + tab).classList.add('active')
    if (tab === 'settings') vscode.postMessage({ type: 'settings_load' })
  })
})

// ── Chat state ────────────────────────────────────────────────────────────────
const messages = document.getElementById('messages')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send')
const agentBtn = document.getElementById('agent-btn')
const teacherBtn = document.getElementById('teacher-btn')

let agentMode = false
let teacherMode = false
let streamingDiv = null
let teacherDiv = null
let busy = false

const savedState = vscode.getState()
if (savedState?.history) {
  messages.innerHTML = ''
  savedState.history.forEach(item => addMessage(item.text, item.role, false))
}
if (savedState?.agentMode) setAgentMode(savedState.agentMode)
if (savedState?.teacherMode) setTeacherMode(savedState.teacherMode)

function setAgentMode(val) {
  agentMode = val
  agentBtn.classList.toggle('on', val)
  agentBtn.textContent = val ? '🤖 Agent ON' : '🤖 Agent'
  updatePlaceholder()
  saveState()
}
function setTeacherMode(val) {
  teacherMode = val
  teacherBtn.classList.toggle('teacher-on', val)
  teacherBtn.textContent = val ? '🎓 Teacher ON' : '🎓 Teacher'
  saveState()
}
function updatePlaceholder() {
  input.placeholder = agentMode
    ? 'Agent 명령 입력… (파일 읽기/수정/생성/실행/Git)'
    : '메시지 입력… (Enter 전송, Shift+Enter 줄바꿈)'
}

agentBtn.addEventListener('click', () => setAgentMode(!agentMode))
teacherBtn.addEventListener('click', () => setTeacherMode(!teacherMode))

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
function renderMarkdown(text) {
  // 코드블록 처리
  text = text.replace(/\`\`\`(\\w*)[\\r\\n]?([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
    var c = code.trim()
    if (typeof hljs !== 'undefined') {
      try {
        var h = lang && hljs.getLanguage(lang) ? hljs.highlight(c,{language:lang}).value : hljs.highlightAuto(c).value
        return '<pre><code class="hljs">' + h + '</code></pre>'
      } catch(e) {}
    }
    return '<pre><code>' + escapeHtml(c) + '</code></pre>'
  })
  // 인라인 코드
  text = text.replace(/\`([^\`\\n]+)\`/g, function(_, c){ return '<code>' + escapeHtml(c) + '</code>' })
  // 볼드 / 이탤릭
  text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
  text = text.replace(/\\*([^\\n*]+)\\*/g, '<em>$1</em>')
  // 줄바꿈
  text = text.replace(/\\n/g, '<br>')
  return text
}

function saveState() {
  const items = messages.querySelectorAll('.msg:not(.loading):not(.agent-event)')
  const history = Array.from(items).map(el => ({
    text: el.dataset.raw !== undefined ? el.dataset.raw : (el.textContent || ''),
    role: el.classList.contains('user') ? 'user' : el.classList.contains('teacher') ? 'teacher' : 'assistant'
  }))
  vscode.setState({ history, agentMode, teacherMode })
}

function addMessage(text, role, save = true) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.dataset.raw = text
  if (role === 'assistant' || role === 'teacher') {
    div.innerHTML = renderMarkdown(text)
  } else {
    div.textContent = text
  }
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
  if (save) saveState()
  return div
}

function setBusy(val) {
  busy = val
  sendBtn.disabled = val
  // 모드 토글 버튼은 항상 클릭 가능하게 유지
}

// ── Send message ──────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendMessage()
  }
})
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
})

function sendMessage() {
  const text = input.value.trim()
  if (!text || busy) return
  addMessage(text, 'user')
  input.value = ''
  input.style.height = 'auto'
  setBusy(true)
  streamingDiv = null
  teacherDiv = null
  addMessage(agentMode ? '🤖 분석 중…' : '생각 중…', 'assistant loading', false)
  vscode.postMessage({ type: 'chat', text, agentMode, teacherMode })
}

// ── Message receiver ──────────────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const msg = e.data

  // Streaming chat token
  if (msg.type === 'stream_chunk') {
    const loading = messages.querySelector('.loading')
    if (loading) loading.remove()
    if (!streamingDiv) {
      streamingDiv = document.createElement('div')
      streamingDiv.className = 'msg assistant'
      streamingDiv.dataset.raw = ''
      messages.appendChild(streamingDiv)
    }
    streamingDiv.dataset.raw += msg.text
    streamingDiv.innerHTML = renderMarkdown(streamingDiv.dataset.raw)
    messages.scrollTop = messages.scrollHeight
    return
  }

  // Streaming done (chat mode)
  if (msg.type === 'stream_done') {
    if (streamingDiv) { streamingDiv = null; saveState() }
    if (!teacherMode) {
      // Teacher 모드가 꺼져 있으면 즉시 잠금 해제
      setBusy(false)
      input.focus()
    }
    // Teacher 모드면 teacher_done을 받을 때 잠금 해제 (백엔드가 항상 보장)
    return
  }

  // Agent tool event
  if (msg.type === 'agent_event') {
    const loading = messages.querySelector('.loading')
    if (loading) loading.remove()
    const div = document.createElement('div')
    div.className = 'agent-event'
    div.textContent = msg.text
    messages.appendChild(div)
    messages.scrollTop = messages.scrollHeight
    return
  }

  // Agent final response (via stream_chunk) + done
  if (msg.type === 'agent_done') {
    if (streamingDiv) { streamingDiv = null; saveState() }
    if (msg.error) addMessage(msg.error, 'assistant')
    setBusy(false)
    input.focus()
    return
  }

  // Teacher (Claude) streaming
  if (msg.type === 'teacher_chunk') {
    if (!teacherDiv) {
      teacherDiv = document.createElement('div')
      teacherDiv.className = 'msg teacher'
      teacherDiv.dataset.raw = ''
      messages.appendChild(teacherDiv)
    }
    teacherDiv.dataset.raw += msg.text
    teacherDiv.innerHTML = '🎓 <strong>Claude 선생님</strong><br>' + renderMarkdown(teacherDiv.dataset.raw)
    messages.scrollTop = messages.scrollHeight
    return
  }

  if (msg.type === 'teacher_done') {
    if (teacherDiv) { teacherDiv = null; saveState() }
    setBusy(false)
    input.focus()
    return
  }

  // Git results
  if (msg.type === 'git_result') {
    document.getElementById('git-output').textContent =
      (msg.success ? '' : '❌ 오류:\\n') + (msg.text || '(결과 없음)')
    return
  }

  // Settings loaded
  if (msg.type === 'settings') {
    if (msg.claudeApiKey) document.getElementById('claude-key').placeholder = msg.claudeApiKey
    document.getElementById('local-model').value = msg.localModel
    return
  }

  if (msg.type === 'settings_saved') {
    const st = document.getElementById('settings-status')
    st.textContent = '✅ 저장되었습니다.'
    setTimeout(() => { st.textContent = '' }, 3000)
    return
  }

  // 빌드 에러 자동 수정 트리거
  if (msg.type === 'auto_fix_request') {
    setAgentMode(true)
    input.value = msg.text
    sendMessage()
    return
  }
})

// ── Git panel ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.git-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action
    document.getElementById('git-output').textContent = '로딩 중…'
    vscode.postMessage({ type: 'git', action })
  })
})

document.getElementById('do-commit').addEventListener('click', () => {
  const msg = document.getElementById('commit-msg').value.trim()
  if (!msg) { alert('커밋 메시지를 입력하세요.'); return }
  document.getElementById('git-output').textContent = '커밋 중…'
  vscode.postMessage({ type: 'git', action: 'commit', commitMsg: msg })
  document.getElementById('commit-msg').value = ''
})

// ── Settings panel ────────────────────────────────────────────────────────────
document.getElementById('save-settings').addEventListener('click', () => {
  const claudeApiKey = document.getElementById('claude-key').value.trim()
  const localModel = document.getElementById('local-model').value.trim()
  vscode.postMessage({ type: 'settings_save', claudeApiKey: claudeApiKey || undefined, localModel: localModel || undefined })
  document.getElementById('claude-key').value = ''
})
</script>
</body>
</html>`
  }
}

export function deactivate() {}
