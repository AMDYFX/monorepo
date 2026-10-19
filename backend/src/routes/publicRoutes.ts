import { Router, Request, Response } from "express"
import { env } from "../schemas/env.js"
import { validate } from "../middleware/validate.js"
import { echoRequestSchema, type EchoResponse } from "../schemas/echo.js"
import { cacheControl, CachePresets, registerEndpointCache } from "../middleware/cacheControl.js"
import { getPool } from "../db.js"
import { MemoryCacheLayer } from "../utils/cache.js"

const publicRouter = Router()

// Register cache configurations for public routes
registerEndpointCache('/soroban/config', {
  ...CachePresets.static,
  tags: ['soroban', 'config'],
  cacheKey: 'soroban:config',
})

registerEndpointCache('/api/example/echo', CachePresets.noCache)

const statsCache = new MemoryCacheLayer<Record<string, unknown>>({
  max: 10,
  ttlMs: 300000,
})

publicRouter.get(
  "/soroban/config",
  cacheControl(CachePresets.static),
  (_req: Request, res: Response) => {
    res.json({
      rpcUrl: env.SOROBAN_RPC_URL,
      networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE,
      contractId: env.SOROBAN_CONTRACT_ID || null,
    })
  }
)

publicRouter.get(
  "/api/public/stats",
  cacheControl(CachePresets.static),
  async (_req: Request, res: Response) => {
    const cached = await statsCache.get("platform-stats")
    if (cached) {
      return res.json(cached)
    }

    let landlordCount = 0
    let tenantCount = 0
    let totalPaidNgn = 0
    let totalFinancedNgn = 0
    let citiesCount = 0
    let defaultRate = 0

    try {
      const pool = await getPool()
      if (pool) {
        const { rows: landlordRows } = await pool.query(
          "SELECT COUNT(*) as count FROM users WHERE role = 'landlord' AND deleted_at IS NULL"
        )
        landlordCount = Number(landlordRows[0]?.count || 0)

        const { rows: tenantRows } = await pool.query(
          "SELECT COUNT(*) as count FROM users WHERE role = 'tenant' AND deleted_at IS NULL"
        )
        tenantCount = Number(tenantRows[0]?.count || 0)

        const { rows: paidRows } = await pool.query(
          `SELECT COALESCE(SUM(amount_ngn), 0) as total
           FROM settlement_ledger_entries
           WHERE beneficiary_type = 'landlord'`
        )
        totalPaidNgn = Number(paidRows[0]?.total || 0)

        const { rows: financedRows } = await pool.query(
          `SELECT COALESCE(SUM(financed_amount_ngn), 0) as total
           FROM tenant_deals WHERE deleted_at IS NULL`
        )
        totalFinancedNgn = Number(financedRows[0]?.total || 0)

        const { rows: citiesRows } = await pool.query(
          `SELECT COUNT(DISTINCT city) as count
           FROM landlord_properties
           WHERE city IS NOT NULL AND city != ''`
        )
        citiesCount = Number(citiesRows[0]?.count || 0)

        const { rows: defRows } = await pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'defaulted') as defaulted,
             COUNT(*) as total
           FROM tenant_deals WHERE deleted_at IS NULL`
        )
        const defaulted = Number(defRows[0]?.defaulted || 0)
        const totalDeals = Number(defRows[0]?.total || 0)
        defaultRate = totalDeals > 0
          ? parseFloat(((defaulted / totalDeals) * 100).toFixed(1))
          : 0
      }
    } catch {
      // If DB is unavailable, return zeros rather than failing
    }

    function formatNgnAmount(amount: number): string {
      if (amount >= 1_000_000_000) {
        return `₦${(amount / 1_000_000_000).toFixed(0)}B+`
      }
      if (amount >= 1_000_000) {
        return `₦${(amount / 1_000_000).toFixed(0)}M+`
      }
      return `₦${(amount / 1_000).toFixed(0)}K+`
    }

    const payload = {
      success: true,
      data: {
        // Homepage stats
        happyTenants: tenantCount > 0 ? `${tenantCount.toLocaleString()}+` : "0",
        rentFinanced: formatNgnAmount(totalFinancedNgn),
        partnerLandlords: landlordCount > 0 ? `${landlordCount}+` : "0",
        citiesCovered: citiesCount > 0 ? `${citiesCount}` : "0",
        // Landlords page stats
        totalPaidToLandlords: formatNgnAmount(totalPaidNgn),
        avgPaymentTime: "48hrs",
        landlordDefaultRate: `${defaultRate}%`,
      },
    }

    await statsCache.set("platform-stats", payload)
    res.json(payload)
  }
)

// Example endpoint demonstrating Zod validation
publicRouter.post(
  "/api/example/echo",
  validate(echoRequestSchema, "body"),
  cacheControl(CachePresets.noCache),
  (req: Request, res: Response) => {
    const { message, timestamp } = req.body
    const response: EchoResponse = {
      echo: message,
      receivedAt: new Date().toISOString(),
      ...(timestamp ? { originalTimestamp: timestamp } : {}),
    }
    res.json(response)
  },
)

export default publicRouter