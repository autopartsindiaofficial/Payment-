import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export interface OrderRecord {
  order_id: string;
  user_id: string;
  plan_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: Date | string;
}

export interface SubscriptionRecord {
  user_id: string;
  is_premium: boolean;
  plan_id: string | null;
  expires_at: Date | string | null;
  last_payment_id: string | null;
  last_order_id: string | null;
  updated_at: Date | string;
}

export interface PremiumStatusResult {
  isPremium: boolean;
  planId: string | null;
  expiresAt: string | null;
}

export interface ActivationResult {
  status: 'activated' | 'already_processed' | 'conflict';
  isPremium: boolean;
  planId: string | null;
  expiresAt: string | null;
  message?: string;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let poolInstance: Pool | null = null;
let schemaInitPromise: Promise<void> | null = null;

function resolveSslOption(connectionString: string): false | { rejectUnauthorized: boolean } {
  try {
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (
      sslMode === 'disable' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    ) {
      return false;
    }
  } catch {
    // Fallback to secure SSL if URL parsing fails
  }
  return { rejectUnauthorized: true };
}

export function getPool(): Pool {
  if (poolInstance) {
    return poolInstance;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new DatabaseConfigError('DATABASE_URL is not configured on the server');
  }

  const pool = new Pool({
    connectionString,
    ssl: resolveSslOption(connectionString),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  poolInstance = pool;
  return pool;
}

export async function ensureSchema(): Promise<void> {
  const pool = getPool();

  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          currency TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

        CREATE TABLE IF NOT EXISTS subscriptions (
          user_id TEXT PRIMARY KEY,
          is_premium BOOLEAN NOT NULL DEFAULT FALSE,
          plan_id TEXT,
          expires_at TIMESTAMPTZ,
          last_payment_id TEXT,
          last_order_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS processed_payments (
          id SERIAL PRIMARY KEY,
          payment_id TEXT UNIQUE,
          order_id TEXT UNIQUE,
          user_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS webhook_events (
          event_key TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          user_id TEXT,
          plan_id TEXT,
          payment_id TEXT,
          order_id TEXT,
          processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    })().catch((err) => {
      schemaInitPromise = null;
      throw err;
    });
  }

  await schemaInitPromise;
}

export async function closeDb(): Promise<void> {
  if (poolInstance) {
    const pool = poolInstance;
    poolInstance = null;
    schemaInitPromise = null;
    await pool.end();
  }
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function computeNextExpiresAt(existingExpiresAt: Date | string | null, durationDays: number): string {
  const nowMs = Date.now();
  let baseMs = nowMs;
  if (existingExpiresAt) {
    const parsed =
      existingExpiresAt instanceof Date
        ? existingExpiresAt.getTime()
        : Date.parse(existingExpiresAt);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      baseMs = parsed;
    }
  }
  return new Date(baseMs + durationDays * MS_PER_DAY).toISOString();
}

export async function saveCreatedOrder(params: {
  orderId: string;
  userId: string;
  planId: string;
  amount: number;
  currency: string;
}): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  await pool.query(
    `
      INSERT INTO orders (order_id, user_id, plan_id, amount, currency, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'created', NOW())
      ON CONFLICT (order_id) DO NOTHING
    `,
    [params.orderId, params.userId, params.planId, params.amount, params.currency]
  );
}

export async function getOrderById(orderId: string): Promise<OrderRecord | null> {
  await ensureSchema();
  const pool = getPool();
  const result = await pool.query<OrderRecord>(
    'SELECT * FROM orders WHERE order_id = $1 LIMIT 1',
    [orderId]
  );
  return result.rows[0] ?? null;
}

async function grantPremiumInTransaction(
  client: PoolClient,
  params: {
    userId: string;
    planId: string;
    durationDays: number;
    paymentId: string | null;
    orderId: string | null;
    source: 'verify-payment' | 'webhook';
  }
): Promise<ActivationResult> {
  // Serialize concurrent activations for the same user / order / payment
  const lockKeys = [
    `user:${params.userId}`,
    params.paymentId ? `pay:${params.paymentId}` : null,
    params.orderId ? `ord:${params.orderId}` : null,
  ]
    .filter((k): k is string => k !== null)
    .sort();

  for (const key of lockKeys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  const existingResult = await client.query<{ user_id: string; plan_id: string }>(
    `
      SELECT user_id, plan_id
      FROM processed_payments
      WHERE ($1::text IS NOT NULL AND payment_id = $1)
         OR ($2::text IS NOT NULL AND order_id = $2)
      LIMIT 1
    `,
    [params.paymentId, params.orderId]
  );

  const existingProcessed = existingResult.rows[0];

  if (existingProcessed) {
    if (existingProcessed.user_id !== params.userId) {
      return {
        status: 'conflict',
        isPremium: false,
        planId: null,
        expiresAt: null,
        message: 'Payment has already been claimed by another user',
      };
    }

    if (params.paymentId || params.orderId) {
      await client.query(
        `
          UPDATE processed_payments
          SET payment_id = COALESCE(payment_id, $1),
              order_id = COALESCE(order_id, $2)
          WHERE user_id = $3
            AND (
              ($1::text IS NOT NULL AND payment_id = $1)
              OR ($2::text IS NOT NULL AND order_id = $2)
            )
        `,
        [params.paymentId, params.orderId, params.userId]
      );
    }

    const subResult = await client.query<SubscriptionRecord>(
      'SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1',
      [params.userId]
    );
    const sub = subResult.rows[0];
    const expiresAtIso = toIsoString(sub?.expires_at);
    const active = Boolean(
      sub &&
        sub.is_premium &&
        expiresAtIso &&
        Date.parse(expiresAtIso) > Date.now()
    );

    return {
      status: 'already_processed',
      isPremium: active,
      planId: sub?.plan_id ?? params.planId,
      expiresAt: expiresAtIso,
    };
  }

  await client.query(
    `
      INSERT INTO processed_payments (payment_id, order_id, user_id, plan_id, source, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    [params.paymentId, params.orderId, params.userId, params.planId, params.source]
  );

  if (params.orderId) {
    await client.query(`UPDATE orders SET status = 'paid' WHERE order_id = $1`, [params.orderId]);
  }

  const currentSubResult = await client.query<SubscriptionRecord>(
    'SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1 FOR UPDATE',
    [params.userId]
  );
  const currentSub = currentSubResult.rows[0];
  const expiresAtIso = computeNextExpiresAt(currentSub?.expires_at ?? null, params.durationDays);

  await client.query(
    `
      INSERT INTO subscriptions (
        user_id, is_premium, plan_id, expires_at, last_payment_id, last_order_id, updated_at
      )
      VALUES ($1, TRUE, $2, $3::timestamptz, $4, $5, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        is_premium = TRUE,
        plan_id = EXCLUDED.plan_id,
        expires_at = EXCLUDED.expires_at,
        last_payment_id = COALESCE(EXCLUDED.last_payment_id, subscriptions.last_payment_id),
        last_order_id = COALESCE(EXCLUDED.last_order_id, subscriptions.last_order_id),
        updated_at = NOW()
    `,
    [params.userId, params.planId, expiresAtIso, params.paymentId, params.orderId]
  );

  return {
    status: 'activated',
    isPremium: true,
    planId: params.planId,
    expiresAt: expiresAtIso,
  };
}

export async function activatePremiumFromVerification(params: {
  userId: string;
  planId: string;
  durationDays: number;
  paymentId: string;
  orderId: string;
}): Promise<ActivationResult> {
  return withTransaction(async (client) => {
    const orderResult = await client.query<OrderRecord>(
      'SELECT * FROM orders WHERE order_id = $1 LIMIT 1',
      [params.orderId]
    );
    const existingOrder = orderResult.rows[0];

    if (existingOrder) {
      if (existingOrder.user_id !== params.userId || existingOrder.plan_id !== params.planId) {
        return {
          status: 'conflict',
          isPremium: false,
          planId: null,
          expiresAt: null,
          message: 'Order does not match the specified userId or planId',
        };
      }
    }

    return grantPremiumInTransaction(client, {
      userId: params.userId,
      planId: params.planId,
      durationDays: params.durationDays,
      paymentId: params.paymentId,
      orderId: params.orderId,
      source: 'verify-payment',
    });
  });
}

export async function activatePremiumFromWebhook(params: {
  eventKey: string;
  eventType: string;
  userId: string;
  planId: string;
  durationDays: number;
  paymentId: string | null;
  orderId: string | null;
}): Promise<ActivationResult> {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evt:${params.eventKey}`]);

    const existingEvent = await client.query<{ event_key: string }>(
      'SELECT event_key FROM webhook_events WHERE event_key = $1 LIMIT 1',
      [params.eventKey]
    );

    if (existingEvent.rows[0]) {
      const subResult = await client.query<SubscriptionRecord>(
        'SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1',
        [params.userId]
      );
      const sub = subResult.rows[0];
      const expiresAtIso = toIsoString(sub?.expires_at);
      const active = Boolean(
        sub &&
          sub.is_premium &&
          expiresAtIso &&
          Date.parse(expiresAtIso) > Date.now()
      );

      return {
        status: 'already_processed',
        isPremium: active,
        planId: sub?.plan_id ?? params.planId,
        expiresAt: expiresAtIso,
      };
    }

    const result = await grantPremiumInTransaction(client, {
      userId: params.userId,
      planId: params.planId,
      durationDays: params.durationDays,
      paymentId: params.paymentId,
      orderId: params.orderId,
      source: 'webhook',
    });

    await client.query(
      `
        INSERT INTO webhook_events (event_key, event_type, user_id, plan_id, payment_id, order_id, processed_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (event_key) DO NOTHING
      `,
      [
        params.eventKey,
        params.eventType,
        params.userId,
        params.planId,
        params.paymentId,
        params.orderId,
      ]
    );

    return result;
  });
}

export async function getPremiumStatus(userId: string): Promise<PremiumStatusResult> {
  await ensureSchema();
  const pool = getPool();
  const result = await pool.query<SubscriptionRecord>(
    'SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const sub = result.rows[0];

  if (!sub || !sub.is_premium || !sub.expires_at) {
    return {
      isPremium: false,
      planId: sub?.plan_id ?? null,
      expiresAt: toIsoString(sub?.expires_at),
    };
  }

  const expiresAtIso = toIsoString(sub.expires_at);
  const isActive = Boolean(expiresAtIso && Date.parse(expiresAtIso) > Date.now());

  return {
    isPremium: isActive,
    planId: sub.plan_id,
    expiresAt: expiresAtIso,
  };
}
