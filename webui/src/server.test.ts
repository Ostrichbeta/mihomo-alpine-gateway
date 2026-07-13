import { describe, expect, it } from 'bun:test'
import { createApp, dashboardLocation, type CommandExecutor } from './server'

const env = {
  WEBUI_ADMIN_PASSWORD: 'secret',
  MIHOMO_API_SECRET: 'mihomo-secret',
  MIHOMO_EXTERNAL_CONTROLLER: '0.0.0.0:9090'
}

describe('webui auth', () => {
  it('rejects unauthenticated API calls', async () => {
    const app = createApp({ env })

    const res = await app.handle(new Request('http://gateway.local/api/status'))

    expect(res.status).toBe(401)
  })

  it('sets an HttpOnly session cookie on login', async () => {
    const app = createApp({ env })

    const res = await login(app)

    expect(res.status).toBe(303)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(res.headers.get('set-cookie')).toContain('SameSite=Strict')
  })

  it('invalidates the session on logout', async () => {
    const app = createApp({ env })
    const cookie = await sessionCookie(app)

    const logout = await app.handle(
      new Request('http://gateway.local/logout', {
        method: 'POST',
        headers: { cookie }
      })
    )
    const res = await app.handle(
      new Request('http://gateway.local/api/status', {
        headers: { cookie }
      })
    )

    expect(logout.status).toBe(303)
    expect(res.status).toBe(401)
  })
})

describe('webui dashboard redirect', () => {
  it('builds a MetaCubeXD setup URL using the request host and controller port', async () => {
    const app = createApp({ env })
    const cookie = await sessionCookie(app)

    const res = await app.handle(
      new Request('http://gateway.local:8080/dashboard', {
        headers: { cookie }
      })
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'http://gateway.local:9090/ui/#/setup?hostname=gateway.local&port=9090&secret=mihomo-secret&http=1'
    )
  })

  it('falls back to port 9090 for malformed controller values', () => {
    expect(dashboardLocation('http://box:8080/dashboard', 'not-a-host', 's')).toBe(
      'http://box:9090/ui/#/setup?hostname=box&port=9090&secret=s&http=1'
    )
  })
})

describe('webui service commands', () => {
  it('maps service actions to OpenRC and pkill commands', async () => {
    const calls: string[] = []
    const exec: CommandExecutor = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    }
    const app = createApp({ env, exec })
    const cookie = await sessionCookie(app)

    for (const action of ['start', 'stop', 'reload', 'kill']) {
      const res = await app.handle(
        new Request(`http://gateway.local/api/service/${action}`, {
          method: 'POST',
          headers: { cookie }
        })
      )

      expect(res.status).toBe(200)
    }

    expect(calls).toEqual([
      'rc-service mihomo start',
      'rc-service mihomo stop',
      'rc-service mihomo restart',
      'pkill -9 mihomo'
    ])
  })

  it('returns mihomo status from rc-service', async () => {
    const exec: CommandExecutor = async (cmd, args) => {
      expect([cmd, ...args].join(' ')).toBe('rc-service mihomo status')
      return { exitCode: 0, stdout: 'started', stderr: '' }
    }
    const app = createApp({ env, exec })
    const cookie = await sessionCookie(app)

    const res = await app.handle(
      new Request('http://gateway.local/api/status', {
        headers: { cookie }
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ running: true, output: 'started' })
  })
})

describe('webui logs', () => {
  it('rejects unauthenticated log streams', async () => {
    const app = createApp({ env })

    const res = await app.handle(new Request('http://gateway.local/api/logs/stream'))

    expect(res.status).toBe(401)
  })

  it('renders the mihomo log stream panel', async () => {
    const app = createApp({ env })
    const cookie = await sessionCookie(app)

    const res = await app.handle(
      new Request('http://gateway.local/', {
        headers: { cookie }
      })
    )
    const html = await res.text()

    expect(html).toContain('mihomo Logs')
    expect(html).toContain("new EventSource('/api/logs/stream')")
  })
})

async function login(app: ReturnType<typeof createApp>) {
  return app.handle(
    new Request('http://gateway.local/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret' })
    })
  )
}

async function sessionCookie(app: ReturnType<typeof createApp>) {
  const res = await login(app)
  return res.headers.get('set-cookie') ?? ''
}
