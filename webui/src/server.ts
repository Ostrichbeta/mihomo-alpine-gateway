import { Elysia } from 'elysia'

const SESSION_COOKIE = 'webui_session'
const DEFAULT_WEBUI_PORT = 8080
const DEFAULT_CONTROLLER = '0.0.0.0:9090'
const MIHOMO_LOG_PATH = '/var/log/mihomo/mihomo.log'

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandExecutor = (cmd: string, args: string[]) => Promise<CommandResult>

export type WebUiEnv = {
  WEBUI_ADMIN_PASSWORD?: string
  WEBUI_PORT?: string
  MIHOMO_API_SECRET?: string
  MIHOMO_EXTERNAL_CONTROLLER?: string
}

type CreateAppOptions = {
  env?: WebUiEnv
  exec?: CommandExecutor
}

const serviceActions: Record<string, [string, string[]]> = {
  start: ['rc-service', ['mihomo', 'start']],
  stop: ['rc-service', ['mihomo', 'stop']],
  reload: ['rc-service', ['mihomo', 'restart']],
  kill: ['pkill', ['-9', 'mihomo']]
}

const sessions = new Map<string, number>()
const sessionTtlMs = 12 * 60 * 60 * 1000

export function createApp({ env = process.env, exec = defaultExec }: CreateAppOptions = {}) {
  const adminPassword = env.WEBUI_ADMIN_PASSWORD

  if (!adminPassword) {
    throw new Error('WEBUI_ADMIN_PASSWORD is required')
  }

  return new Elysia()
    .get('/', ({ request }) => {
      if (!hasValidSession(request)) {
        return html(loginPage(), 401)
      }

      return html(adminPage())
    })
    .post('/login', async ({ request }) => {
      const password = await readPassword(request)

      if (!constantTimeEqual(password, adminPassword)) {
        return html(loginPage('Invalid password'), 401)
      }

      const token = crypto.randomUUID()
      sessions.set(token, Date.now() + sessionTtlMs)

      return new Response(null, {
        status: 303,
        headers: {
          location: '/',
          'set-cookie': serializeSessionCookie(token)
        }
      })
    })
    .post('/logout', ({ request }) => {
      const token = parseCookies(request.headers.get('cookie') ?? '')[SESSION_COOKIE]
      if (token) {
        sessions.delete(token)
      }

      return new Response(null, {
        status: 303,
        headers: {
          location: '/',
          'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
        }
      })
    })
    .get('/dashboard', ({ request }) => {
      if (!hasValidSession(request)) {
        return unauthorized()
      }

      const location = dashboardLocation(
        request.url,
        env.MIHOMO_EXTERNAL_CONTROLLER ?? DEFAULT_CONTROLLER,
        env.MIHOMO_API_SECRET ?? ''
      )

      return new Response(null, {
        status: 302,
        headers: { location }
      })
    })
    .get('/api/status', async ({ request }) => {
      if (!hasValidSession(request)) {
        return unauthorized()
      }

      const result = await exec('rc-service', ['mihomo', 'status'])
      return Response.json({
        service: 'mihomo',
        running: result.exitCode === 0,
        exitCode: result.exitCode,
        output: (result.stdout || result.stderr).trim()
      })
    })
    .get('/api/logs/stream', ({ request }) => {
      if (!hasValidSession(request)) {
        return unauthorized()
      }

      return streamMihomoLogs(request.signal)
    })
    .post('/api/service/:action', async ({ request, params }) => {
      if (!hasValidSession(request)) {
        return unauthorized()
      }

      const command = serviceActions[params.action]
      if (!command) {
        return Response.json({ error: 'Unknown action' }, { status: 404 })
      }

      const [cmd, args] = command
      const result = await exec(cmd, args)
      const ok = result.exitCode === 0

      return Response.json(
        {
          ok,
          action: params.action,
          exitCode: result.exitCode,
          output: (result.stdout || result.stderr).trim()
        },
        { status: ok ? 200 : 500 }
      )
    })
}

export function dashboardLocation(requestUrl: string, controller: string, secret: string) {
  const requested = new URL(requestUrl)
  const controllerPort = controllerPortFrom(controller)

  requested.protocol = 'http:'
  requested.port = controllerPort
  requested.pathname = '/ui/'
  requested.search = ''

  const params = new URLSearchParams({
    hostname: requested.hostname,
    port: controllerPort,
    secret,
    http: '1'
  })

  requested.hash = `/setup?${params.toString()}`
  return requested.toString()
}

export function controllerPortFrom(controller: string) {
  const fallback = '9090'

  if (controller.startsWith(':')) {
    return controller.slice(1) || fallback
  }

  try {
    const parsed = new URL(controller.includes('://') ? controller : `http://${controller}`)
    return parsed.port || fallback
  } catch {
    const port = controller.split(':').pop()
    return port && /^\d+$/.test(port) ? port : fallback
  }
}

async function defaultExec(cmd: string, args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe'
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  return { exitCode, stdout, stderr }
}

function hasValidSession(request: Request) {
  const token = parseCookies(request.headers.get('cookie') ?? '')[SESSION_COOKIE]
  if (!token) {
    return false
  }

  const expiresAt = sessions.get(token)
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token)
    return false
  }

  return true
}

async function readPassword(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    return typeof body.password === 'string' ? body.password : ''
  }

  const form = await request.formData().catch(() => undefined)
  const password = form?.get('password')
  return typeof password === 'string' ? password : ''
}

function parseCookies(cookieHeader: string) {
  const cookies: Record<string, string> = {}

  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=')
    if (!name) {
      continue
    }

    cookies[name] = decodeURIComponent(valueParts.join('='))
  }

  return cookies
}

function serializeSessionCookie(token: string) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    sessionTtlMs / 1000
  )}`
}

function constantTimeEqual(actual: string, expected: string) {
  const encoder = new TextEncoder()
  const actualBytes = encoder.encode(actual)
  const expectedBytes = encoder.encode(expected)
  const maxLength = Math.max(actualBytes.length, expectedBytes.length)

  let diff = actualBytes.length ^ expectedBytes.length
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (actualBytes[i] ?? 0) ^ (expectedBytes[i] ?? 0)
  }

  return diff === 0
}

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function streamMihomoLogs(signal: AbortSignal) {
  const encoder = new TextEncoder()
  const proc = Bun.spawn(['tail', '-n', '50', '-f', MIHOMO_LOG_PATH], {
    stdout: 'pipe',
    stderr: 'pipe'
  })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = ''
      const decoder = new TextDecoder()

      const send = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`))
      }

      const stop = () => {
        proc.kill()
      }

      signal.addEventListener('abort', stop, { once: true })
      send('ready', { ok: true })

      try {
        const reader = proc.stdout.getReader()
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            send('log', line)
          }
        }

        if (buffer) {
          send('log', buffer)
        }
      } catch (error) {
        if (!signal.aborted) {
          send('log-error', error instanceof Error ? error.message : 'Unable to stream mihomo logs')
        }
      } finally {
        signal.removeEventListener('abort', stop)
        proc.kill()
        controller.close()
      }
    },
    cancel() {
      proc.kill()
    }
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

function loginPage(error = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mihomo Gateway</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101820; color: #f7fafc; }
    main { width: min(360px, calc(100vw - 32px)); }
    h1 { font-size: 1.5rem; margin: 0 0 20px; font-weight: 650; }
    form { display: grid; gap: 12px; }
    input, button { box-sizing: border-box; width: 100%; border: 1px solid #365163; border-radius: 8px; padding: 12px 14px; font: inherit; }
    input { background: #172532; color: inherit; }
    button { background: #f4c542; color: #111; border: 0; font-weight: 700; cursor: pointer; }
    p { min-height: 1.4em; margin: 0 0 12px; color: #ffb4a9; }
  </style>
</head>
<body>
  <main>
    <h1>mihomo Gateway</h1>
    <p>${escapeHtml(error)}</p>
    <form method="post" action="/login">
      <input name="password" type="password" autocomplete="current-password" placeholder="Admin password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`
}

function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mihomo Gateway</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #17212b; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; background: #101820; color: #f7fafc; }
    h1 { font-size: 1.15rem; margin: 0; font-weight: 650; }
    main { width: min(760px, calc(100vw - 32px)); margin: 32px auto; display: grid; gap: 20px; }
    section { background: #fff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 20px; }
    h2 { font-size: 0.95rem; margin: 0 0 14px; color: #425466; }
    .status { font-size: 1.75rem; font-weight: 720; margin: 0; }
    .output { white-space: pre-wrap; color: #425466; margin: 8px 0 0; min-height: 1.3em; }
    .log {
      background: #101820;
      border-radius: 8px;
      color: #dbe7ef;
      font: 0.82rem ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      line-height: 1.45;
      margin: 0;
      max-height: 420px;
      min-height: 220px;
      overflow: auto;
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    button, a.button { border: 1px solid #c4ced8; background: #fff; color: #17212b; border-radius: 8px; padding: 10px 14px; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; }
    button.primary, a.primary { background: #116466; color: white; border-color: #116466; }
    button.danger { background: #b42318; color: white; border-color: #b42318; }
    form { margin: 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #101820; color: #eef4f8; }
      section, button, a.button { background: #172532; color: #eef4f8; border-color: #365163; }
      h2, .output { color: #a9b8c4; }
      .log { background: #0b1117; color: #dbe7ef; }
    }
  </style>
</head>
<body>
  <header>
    <h1>mihomo Gateway</h1>
    <form method="post" action="/logout"><button type="submit">Sign out</button></form>
  </header>
  <main>
    <section>
      <h2>Service Status</h2>
      <p id="state" class="status">Checking...</p>
      <p id="output" class="output"></p>
    </section>
    <section>
      <h2>Controls</h2>
      <div class="actions">
        <button class="primary" data-action="start">Start</button>
        <button data-action="stop">Stop</button>
        <button data-action="reload">Reload</button>
        <button class="danger" data-action="kill">Kill</button>
        <a class="button primary" href="/dashboard">MetaCubeXD</a>
      </div>
    </section>
    <section>
      <h2>mihomo Logs</h2>
      <pre id="logs" class="log">Connecting...</pre>
    </section>
  </main>
  <script>
    const state = document.getElementById('state');
    const output = document.getElementById('output');
    const logs = document.getElementById('logs');
    const logLines = [];

    async function refresh() {
      const res = await fetch('/api/status');
      const data = await res.json();
      state.textContent = data.running ? 'Running' : 'Stopped';
      output.textContent = data.output || '';
    }

    async function act(action) {
      const res = await fetch('/api/service/' + action, { method: 'POST' });
      const data = await res.json();
      output.textContent = data.output || (data.ok ? action + ' completed' : action + ' failed');
      await refresh();
    }

    function renderLogs() {
      logs.textContent = logLines.length ? logLines.join('\\n') : 'No log output';
      logs.scrollTop = logs.scrollHeight;
    }

    function connectLogs() {
      const source = new EventSource('/api/logs/stream');

      source.addEventListener('ready', () => {
        logLines.length = 0;
        logs.textContent = 'Waiting for log output...';
      });

      source.addEventListener('log', (event) => {
        logLines.push(JSON.parse(event.data));
        while (logLines.length > 50) logLines.shift();
        renderLogs();
      });

      source.addEventListener('log-error', (event) => {
        if (event.data) logs.textContent = JSON.parse(event.data);
      });

      source.onerror = () => {
        if (!logLines.length) logs.textContent = 'Log stream disconnected; reconnecting...';
      };
    }

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => act(button.dataset.action));
    });

    refresh().catch((error) => {
      state.textContent = 'Unavailable';
      output.textContent = error.message;
    });
    connectLogs();
  </script>
</body>
</html>`
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

if (import.meta.main) {
  const port = Number(process.env.WEBUI_PORT ?? DEFAULT_WEBUI_PORT)
  createApp().listen(port)
  console.log(`mihomo Web UI listening on :${port}`)
}
