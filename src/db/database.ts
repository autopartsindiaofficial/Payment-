import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface OrderRecord {
  order_id: string;
  user_id: string;
  plan_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface SubscriptionRecord {
  user_id: string;
  is_premium: number;
  plan_id: string | null;
  expires_at: string | null;
  last_payment_id: string | null;
  last_order_id: string | null;
  updated_at: string;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveDbPath(): string {
  const configured = process.env.DB_PATH?.trim() || './data/chatmate.db';
  return path.resolve(process.cwd(), configured);
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbFilePath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

  const db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      is_premium INTEGER NOT NULL DEFAULT 0,
      plan_id TEXT,
      expires_at TEXT,
      last_payment_id TEXT,
      last_order_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT UNIQUE,
      order_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_key TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      user_id TEXT,
      plan_id TEXT,
      payment_id TEXT,
      order_id TEXT,
      processed_at TEXT NOT NULL
    );
  `);

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function saveCreatedOrder(params: {
  orderId: string;
  userId: string;
  planId: string;
  amount: number;
  currency: string;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO orders (order_id, user_id, plan_id, amount, currency, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'created', ?)
    ON CONFLICT(order_id) DO NOTHING
  `);
  stmt.run(
    params.orderId,
    params.userId,
    params.planId,
    params.amount,
    params.currency,
    new Date().toISOString()
  );
}

export function getOrderById(orderId: string): OrderRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM orders WHERE order_id = ?');
  const row = stmt.get(orderId) as OrderRecord | undefined;
  return row ?? null;
}

function computeNextExpiresAt(existingExpiresAt: string | null, durationDays: number): string {
  const nowMs = Date.now();
  let baseMs = nowMs;
  if (existingExpiresAt) {
    const parsed = Date.parse(existingExpiresAt);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      baseMs = parsed;
    }
  }
  return new Date(baseMs + durationDays * MS_PER_DAY).toISOString();
}

function grantPremiumInTransaction(
  db: Database.Database,
  params: {
    userId: string;
    planId: string;
    durationDays: number;
    paymentId: string | null;
    orderId: string | null;
    source: 'verify-payment' | 'webhook';
  }
): ActivationResult {
  const nowIso = new Date().toISOString();

  // Check if this paymentId or orderId was already processed
  let existingProcessed: { user_id: string; plan_id: string } | undefined;

  if (params.paymentId && params.orderId) {
    existingProcessed = db
      .prepare('SELECT user_id, plan_id FROM processed_payments WHERE payment_id = ? OR order_id = ? LIMIT 1')
      .get(params.paymentId, params.orderId) as { user_id: string; plan_id: string } | undefined;
  } else if (params.paymentId) {
    existingProcessed = db
      .prepare('SELECT user_id, plan_id FROM processed_payments WHERE payment_id = ? LIMIT 1')
      .get(params.paymentId) as { user_id: string; plan_id: string } | undefined;
  } else if (params.orderId) {
    existingProcessed = db
      .prepare('SELECT user_id, plan_id FROM processed_payments WHERE order_id = ? LIMIT 1')
      .get(params.orderId) as { user_id: string; plan_id: string } | undefined;
  }

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

    const sub = db
      .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
      .get(params.userId) as SubscriptionRecord | undefined;

    // Backfill payment_id or order_id if previously recorded with only one of them
    if (params.paymentId || params.orderId) {
      db.prepare(`
        UPDATE processed_payments
        SET payment_id = COALESCE(payment_id, ?),
            order_id = COALESCE(order_id, ?)
        WHERE user_id = ? AND (payment_id = ? OR order_id = ?)
      `).run(
        params.paymentId,
        params.orderId,
        params.userId,
        params.paymentId ?? '',
        params.orderId ?? ''
      );
    }

    const active = Boolean(
      sub &&
        sub.is_premium === 1 &&
        sub.expires_at &&
        Date.parse(sub.expires_at) > Date.now()
    );

    return {
      status: 'already_processed',
      isPremium: active,
      planId: sub?.plan_id ?? params.planId,
      expiresAt: sub?.expires_at ?? null,
    };
  }

  // Record payment first to guarantee idempotency
  db.prepare(`
    INSERT INTO processed_payments (payment_id, order_id, user_id, plan_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.paymentId,
    params.orderId,
    params.userId,
    params.planId,
    params.source,
    nowIso
  );

  if (params.orderId) {
    db.prepare(`UPDATE orders SET status = 'paid' WHERE order_id = ?`).run(params.orderId);
  }

  const currentSub = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
    .get(params.userId) as SubscriptionRecord | undefined;

  const expiresAt = computeNextExpiresAt(currentSub?.expires_at ?? null, params.durationDays);

  db.prepare(`
    INSERT INTO subscriptions (user_id, is_premium, plan_id, expires_at, last_payment_id, last_order_id, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      is_premium = 1,
      plan_id = excluded.plan_id,
      expires_at = excluded.expires_at,
      last_payment_id = COALESCE(excluded.last_payment_id, subscriptions.last_payment_id),
      last_order_id = COALESCE(excluded.last_order_id, subscriptions.last_order_id),
      updated_at = excluded.updated_at
  `).run(
    params.userId,
    params.planId,
    expiresAt,
    params.paymentId,
    params.orderId,
    nowIso
  );

  return {
    status: 'activated',
    isPremium: true,
    planId: params.planId,
    expiresAt,
  };
}

export function activatePremiumFromVerification(params: {
  userId: string;
  planId: string;
  durationDays: number;
  paymentId: string;
  orderId: string;
}): ActivationResult {
  const db = getDb();
  const tx = db.transaction(() => {
    const existingOrder = getOrderById(params.orderId);
    if (existingOrder) {
      if (existingOrder.user_id !== params.userId || existingOrder.plan_id !== params.planId) {
        return {
          status: 'conflict' as const,
          isPremium: false,
          planId: null,
          expiresAt: null,
          message: 'Order does not match the specified userId or planId',
        };
      }
    }

    return grantPremiumInTransaction(db, {
      userId: params.userId,
      planId: params.planId,
      durationDays: params.durationDays,
      paymentId: params.paymentId,
      orderId: params.orderId,
      source: 'verify-payment',
    });
  });

  return tx();
}

export function activatePremiumFromWebhook(params: {
  eventKey: string;
  eventType: string;
  userId: string;
  planId: string;
  durationDays: number;
  paymentId: string | null;
  orderId: string | null;
}): ActivationResult {
  const db = getDb();
  const tx = db.transaction(() => {
    const existingEvent = db
      .prepare('SELECT event_key FROM webhook_events WHERE event_key = ?')
      .get(params.eventKey) as { event_key: string } | undefined;

    if (existingEvent) {
      const sub = db
        .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
        .get(params.userId) as SubscriptionRecord | undefined;

      const active = Boolean(
        sub &&
          sub.is_premium === 1 &&
          sub.expires_at &&
          Date.parse(sub.expires_at) > Date.now()
      );

      return {
        status: 'already_processed' as const,
        isPremium: active,
        planId: sub?.plan_id ?? params.planId,
        expiresAt: sub?.expires_at ?? null,
      };
    }

    const result = grantPremiumInTransaction(db, {
      userId: params.userId,
      planId: params.planId,
      durationDays: params.durationDays,
      paymentId: params.paymentId,
      orderId: params.orderId,
      source: 'webhook',
    });

    db.prepare(`
      INSERT INTO webhook_events (event_key, event_type, user_id, plan_id, payment_id, order_id, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING
    `).run(
      params.eventKey,
      params.eventType,
      params.userId,
      params.planId,
      params.paymentId,
      params.orderId,
      new Date().toISOString()
    );

    return result;
  });

  return tx();
}

export function getPremiumStatus(userId: string): PremiumStatusResult {
  const db = getDb();
  const sub = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
    .get(userId) as SubscriptionRecord | undefined;

  if (!sub || sub.is_premium !== 1 || !sub.expires_at) {
    return {
      isPremium: false,
      planId: sub?.plan_id ?? null,
      expiresAt: sub?.expires_at ?? null,
    };
  }

  const expiresMs = Date.parse(sub.expires_at);
  const isActive = !Number.isNaN(expiresMs) && expiresMs > Date.now();

  return {
    isPremium: isActive,
    planId: sub.plan_id,
    expiresAt: sub.expires_at,
  };
}
