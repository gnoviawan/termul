// The fault scenarios. Each starts from a fresh page streaming a live turn,
// injects its fault through `ctx`, and returns the fault instant plus one or
// more return instants (the moments recovery is timed from).
//
// ctx: proxy (fault-proxy API), sleep(ms), mark(label) -> t, waitForEvent(pred, ms),
//      hide(method?) -> t, show(method?) -> t.

const SEC = 1_000
const MIN = 60 * SEC

export const SCENARIOS = [
  {
    id: 'p0',
    name: 'lifecycle-probe',
    returnDef: 'show/thaw of each method, link blackholed across it',
    turnSec: 300,
    async run(ctx) {
      const returns = []
      const faultAt = ctx.mark('probe start')
      for (const method of ['freeze', 'pause', 'override', 'override+pause']) {
        ctx.mark(`probe ${method}: blackhole + hide`)
        ctx.proxy.blackhole()
        await ctx.hide(method)
        await ctx.sleep(3 * SEC)
        const r = await ctx.show(method)
        returns.push({ t: r, label: method })
        await ctx.sleep(8 * SEC)
        ctx.proxy.pass()
        ctx.mark(`probe ${method}: link back`)
        await ctx.waitRecovered(r, 60 * SEC)
        await ctx.sleep(3 * SEC)
      }
      return { faultAt, returns }
    }
  },
  {
    id: 's1',
    name: 'rst-visible',
    returnDef: 'the RST',
    turnSec: 240,
    async run(ctx) {
      const t = ctx.mark('rst')
      ctx.proxy.rst()
      return { faultAt: t, returns: [{ t }] }
    }
  },
  {
    id: 's2',
    name: 'hidden-rst',
    returnDef: 'thaw (RST 20 s into a 40 s hide)',
    turnSec: 260,
    async run(ctx) {
      const faultAt = await ctx.hide()
      await ctx.sleep(20 * SEC)
      ctx.mark('rst while hidden')
      ctx.proxy.rst()
      await ctx.sleep(20 * SEC)
      return { faultAt, returns: [{ t: await ctx.show() }] }
    }
  },
  {
    id: 's3a',
    name: 'hidden-blackhole',
    returnDef: 'thaw (40 s hidden+blackholed; link back 5 s after thaw)',
    turnSec: 280,
    async run(ctx) {
      const faultAt = await ctx.hide()
      ctx.proxy.blackhole()
      await ctx.sleep(40 * SEC)
      const t = await ctx.show()
      await ctx.sleep(5 * SEC)
      ctx.proxy.pass()
      ctx.mark('link back (held bytes flushed)')
      return { faultAt, returns: [{ t }] }
    }
  },
  {
    id: 's3b',
    name: 'hidden-blackhole-destroy',
    returnDef: 'thaw (40 s hidden+blackholed; held connections reset at thaw)',
    turnSec: 280,
    async run(ctx) {
      const faultAt = await ctx.hide()
      ctx.proxy.blackhole()
      await ctx.sleep(40 * SEC)
      ctx.proxy.endBlackhole('destroy')
      return { faultAt, returns: [{ t: await ctx.show() }] }
    }
  },
  {
    id: 's4',
    name: 'hidden-long',
    returnDef: 'thaw after 6 min hidden, link healthy',
    turnSec: 600,
    async run(ctx) {
      const faultAt = await ctx.hide()
      await ctx.sleep(6 * MIN)
      return { faultAt, returns: [{ t: await ctx.show() }] }
    }
  },
  {
    id: 's5',
    name: 'link-down-60',
    returnDef: 'link back (60 s after every connection was reset and refused)',
    turnSec: 300,
    async run(ctx) {
      const faultAt = ctx.mark('link down')
      ctx.proxy.down()
      await ctx.sleep(60 * SEC)
      ctx.proxy.pass()
      return { faultAt, returns: [{ t: ctx.mark('link back') }] }
    }
  },
  {
    id: 's6',
    name: 'stall-downstream',
    returnDef: 'release (30 s of held server->browser bytes)',
    turnSec: 260,
    async run(ctx) {
      const faultAt = ctx.mark('stall downstream')
      ctx.proxy.stallDownstream()
      await ctx.sleep(30 * SEC)
      ctx.proxy.pass()
      return { faultAt, returns: [{ t: ctx.mark('release') }] }
    }
  },
  {
    id: 's7',
    name: 'flap',
    returnDef: 'each RST (every 45 s for 5 min)',
    turnSec: 520,
    async run(ctx) {
      const returns = []
      const start = Date.now()
      while (Date.now() - start < 5 * MIN) {
        const t = ctx.mark(`flap ${returns.length + 1}: rst`)
        ctx.proxy.rst()
        returns.push({ t, label: `flap ${returns.length + 1}` })
        await ctx.sleep(Math.max(0, t + 45 * SEC - Date.now()))
      }
      return { faultAt: returns[0].t, returns }
    }
  },
  {
    id: 's8',
    name: 'hidden-mid-handshake',
    returnDef: 'show 12 s after the tab hid while its reconnect handshake was in flight',
    turnSec: 240,
    async run(ctx) {
      const faultAt = ctx.mark('rst, then hide once the replacement socket is created')
      ctx.proxy.stallDownstream()
      ctx.proxy.rst()
      await ctx.waitForEvent(
        (e) => e.src === 'page' && e.type === 'ws-new' && e.t > faultAt,
        30 * SEC
      )
      await ctx.hide()
      ctx.proxy.pass()
      await ctx.sleep(12 * SEC)
      return { faultAt, returns: [{ t: await ctx.show() }] }
    }
  }
]
