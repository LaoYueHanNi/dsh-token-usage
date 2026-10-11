import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AssociationError } from './pricing-associations.ts'
import { PricingAssociationService } from './pricing-association-service.ts'
import { isSameOriginFetch } from './stats-route.ts'
import { ASSOCIATIONS_PATH } from './wire.ts'
import { consoleLogger, type LoggerLike } from './log.ts'

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) throw new AssociationError('json-required', 415)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += bytes.length
      if (size > 65_536) throw new AssociationError('body-too-large', 413)
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof AssociationError) throw error
    throw new AssociationError('invalid-json', 400)
  }
}

/** One local endpoint: list/inspect, save, revoke. No GET mutations. */
export function createPricingAssociationsRoute(service: PricingAssociationService, logger: LoggerLike = consoleLogger): WebRoute {
  return {
    kind: 'exact', path: ASSOCIATIONS_PATH,
    handler: async (req, res) => {
      if (!isSameOriginFetch(req)) { reply(res, 403, { error: 'forbidden' }); return }
      if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { reply(res, 405, { error: 'method-not-allowed' }); return }
      let sourceModel: string | undefined
      try {
        if (req.method === 'GET') {
          sourceModel = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sourceModel') ?? undefined
          reply(res, 200, await service.read(sourceModel))
        } else {
          const body = await readBody(req)
          if (typeof body === 'object' && body !== null && 'sourceModel' in body && typeof body.sourceModel === 'string') sourceModel = body.sourceModel
          reply(res, 200, await service.mutate(req.method === 'POST' ? 'save' : 'delete', body))
        }
      } catch (error) {
        if (error instanceof AssociationError) {
          // Conflict responses include the real current state so a caller
          // can refresh its revision, directory epoch and lifecycle status.
          const current = error.statusCode >= 409 ? await service.read(sourceModel).catch(() => undefined) : undefined
          reply(res, error.statusCode, { error: error.code, ...(current !== undefined ? { current } : {}) })
        } else {
          logger.error('[token-usage] association operation failed:', error)
          reply(res, 500, { error: 'association-operation-failed' })
        }
      }
    },
  }
}
