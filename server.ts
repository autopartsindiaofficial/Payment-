import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getPlanById } from './src/config/plans.ts';
import {
  activatePremiumFromVerification,
  activatePremiumFromWebhook,
  closeDb,
  DatabaseConfigError,
  getOrderById,
  getPremiumStatus,
  saveCreatedOrder,
} from './src/db/database.ts';
import {
  isNonEmptyString,
  validateUserId,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from './src/utils/crypto.ts';

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status?: string;
  receipt?: string;
}

interface RazorpayErrorResponse {
  error?: {
    code?: string;
    description?: string;
  };
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        notes?: Record<string, unknown>;
      };
    };
    order?: {
      entity?: {
        id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        notes?: Record<string, unknown>;
      };
    };
  };
}

const PORT = Number(process.env.PORT) || 3000;

function handleDatabaseError(res: Response, error: unknown, context: string): void {
  if (error instanceof DatabaseConfigError) {
    res.status(500).json({ error: 'Database is not configured on the server' });
    return;
  }
  console.error(`${context}:`, error);
  res.status(500).json({ error: 'Database operation failed' });
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Baseline security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // 1. GET / -> return JSON { ok: true, service: "ChatMate Payment Backend" }
  app.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'ChatMate Payment Backend' });
  });

  // 4. POST /webhook -> read raw JSON body BEFORE global express.json() middleware
  app.post(
    '/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req: Request, res: Response) => {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
      if (!webhookSecret) {
        console.error('RAZORPAY_WEBHOOK_SECRET is not configured');
        res.status(500).json({ error: 'Webhook secret is not configured on the server' });
        return;
      }

      const signatureHeader = req.header('x-razorpay-signature');
      if (!isNonEmptyString(signatureHeader, 256)) {
        res.status(400).json({ error: 'Missing x-razorpay-signature header' });
        return;
      }

      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Expected raw JSON request body' });
        return;
      }

      const isValidSignature = verifyRazorpayWebhookSignature({
        rawBody: req.body,
        signatureHeader,
        webhookSecret,
      });

      if (!isValidSignature) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }

      let eventBody: RazorpayWebhookPayload;
      try {
        eventBody = JSON.parse(req.body.toString('utf8')) as RazorpayWebhookPayload;
      } catch {
        res.status(400).json({ error: 'Invalid JSON payload' });
        return;
      }

      const eventType = eventBody.event;
      if (eventType !== 'payment.captured' && eventType !== 'order.paid') {
        res.status(200).json({ received: true, ignored: true, event: eventType ?? 'unknown' });
        return;
      }

      const paymentEntity = eventBody.payload?.payment?.entity;
      const orderEntity = eventBody.payload?.order?.entity;

      const paymentId = isNonEmptyString(paymentEntity?.id, 128) ? paymentEntity.id.trim() : null;
      const orderId = isNonEmptyString(orderEntity?.id, 128)
        ? orderEntity.id.trim()
        : isNonEmptyString(paymentEntity?.order_id, 128)
          ? paymentEntity.order_id.trim()
          : null;

      // Extract userId and planId from payload notes (check both payment and order notes)
      const paymentNotes = paymentEntity?.notes;
      const orderNotes = orderEntity?.notes;

      const rawUserId = paymentNotes?.userId ?? orderNotes?.userId;
      const rawPlanId = paymentNotes?.planId ?? orderNotes?.planId;

      let userId = validateUserId(rawUserId);
      let planId = isNonEmptyString(rawPlanId, 64) ? rawPlanId.trim() : null;

      try {
        // Fallback to stored order record if notes were omitted in a partial webhook payload
        if ((!userId || !planId) && orderId) {
          const storedOrder = await getOrderById(orderId);
          if (storedOrder) {
            userId = userId ?? storedOrder.user_id;
            planId = planId ?? storedOrder.plan_id;
          }
        }

        if (!userId || !planId) {
          res.status(400).json({ error: 'Missing valid userId or planId in webhook payload notes' });
          return;
        }

        const plan = getPlanById(planId);
        if (!plan) {
          res.status(400).json({ error: 'Unsupported planId in webhook payload' });
          return;
        }

        // Verify paid amount and currency when present in Razorpay webhook payload
        const paidAmount = paymentEntity?.amount ?? orderEntity?.amount;
        const paidCurrency = paymentEntity?.currency ?? orderEntity?.currency;
        if (typeof paidAmount === 'number' && paidAmount < plan.amountPaise) {
          res.status(400).json({ error: 'Captured amount is less than plan price' });
          return;
        }
        if (typeof paidCurrency === 'string' && paidCurrency.toUpperCase() !== plan.currency) {
          res.status(400).json({ error: 'Currency mismatch in webhook payload' });
          return;
        }

        const headerEventId = req.header('x-razorpay-event-id');
        const eventKey = isNonEmptyString(headerEventId, 128)
          ? `hdr:${headerEventId.trim()}`
          : `evt:${eventType}:${paymentId ?? ''}:${orderId ?? ''}`;

        const result = await activatePremiumFromWebhook({
          eventKey,
          eventType,
          userId,
          planId: plan.id,
          durationDays: plan.durationDays,
          paymentId,
          orderId,
        });

        if (result.status === 'conflict') {
          res.status(409).json({ error: result.message ?? 'Payment conflict' });
          return;
        }

        res.status(200).json({
          received: true,
          event: eventType,
          idempotent: result.status === 'already_processed',
          userId,
          isPremium: result.isPremium,
          planId: result.planId,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        handleDatabaseError(res, error, 'Webhook database error');
      }
    }
  );

  // JSON body parser for standard endpoints
  app.use(express.json({ limit: '100kb' }));

  // 2. POST /create-order -> accept { userId, planId }, call Razorpay Orders API, return { orderId, amount, currency: "INR", keyId }
  app.post('/create-order', async (req: Request, res: Response) => {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

    if (!keyId || !keySecret) {
      console.error('Razorpay API credentials are not configured');
      res.status(500).json({ error: 'Razorpay API credentials are not configured on the server' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const userId = validateUserId(body?.userId);
    const planIdRaw = body?.planId;

    if (!userId) {
      res.status(400).json({ error: 'Invalid or missing userId' });
      return;
    }

    if (!isNonEmptyString(planIdRaw, 64)) {
      res.status(400).json({ error: 'Invalid or missing planId' });
      return;
    }

    const plan = getPlanById(planIdRaw.trim());
    if (!plan) {
      res.status(400).json({ error: 'Unsupported planId' });
      return;
    }

    // Razorpay requires receipt length <= 40 characters
    const receipt = `rcpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const authToken = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');

    try {
      const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: plan.amountPaise,
          currency: plan.currency,
          receipt,
          notes: {
            userId,
            planId: plan.id,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!razorpayRes.ok) {
        const errPayload = (await razorpayRes.json().catch(() => ({}))) as RazorpayErrorResponse;
        console.error('Razorpay Orders API error:', razorpayRes.status, errPayload.error?.code ?? 'unknown');
        res.status(502).json({
          error: errPayload.error?.description || 'Failed to create Razorpay order',
        });
        return;
      }

      const order = (await razorpayRes.json()) as RazorpayOrderResponse;
      await saveCreatedOrder({
        orderId: order.id,
        userId,
        planId: plan.id,
        amount: order.amount,
        currency: order.currency,
      });

      res.status(200).json({
        orderId: order.id,
        amount: order.amount,
        currency: 'INR',
        keyId,
      });
    } catch (error) {
      if (error instanceof DatabaseConfigError) {
        handleDatabaseError(res, error, 'Order persistence error');
        return;
      }
      console.error('Razorpay order creation request failed:', error);
      res.status(502).json({ error: 'Unable to reach Razorpay Orders API' });
    }
  });

  // 3. POST /verify-payment -> verify HMAC-SHA256 signature, save premium (+365 days), return { verified: true, isPremium: true, expiresAt }
  app.post('/verify-payment', async (req: Request, res: Response) => {
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keySecret) {
      console.error('RAZORPAY_KEY_SECRET is not configured');
      res.status(500).json({ error: 'Razorpay key secret is not configured on the server' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const userId = validateUserId(body?.userId);
    const planIdRaw = body?.planId;
    const orderIdRaw = body?.razorpay_order_id;
    const paymentIdRaw = body?.razorpay_payment_id;
    const signatureRaw = body?.razorpay_signature;

    if (!userId) {
      res.status(400).json({ error: 'Invalid or missing userId' });
      return;
    }
    if (!isNonEmptyString(planIdRaw, 64)) {
      res.status(400).json({ error: 'Invalid or missing planId' });
      return;
    }
    const plan = getPlanById(planIdRaw.trim());
    if (!plan) {
      res.status(400).json({ error: 'Unsupported planId' });
      return;
    }

    if (
      !isNonEmptyString(orderIdRaw, 128) ||
      !isNonEmptyString(paymentIdRaw, 128) ||
      !isNonEmptyString(signatureRaw, 256)
    ) {
      res.status(400).json({
        error: 'Missing required fields: razorpay_order_id, razorpay_payment_id, razorpay_signature',
      });
      return;
    }

    const orderId = orderIdRaw.trim();
    const paymentId = paymentIdRaw.trim();
    const signature = signatureRaw.trim();

    const isValid = verifyRazorpayPaymentSignature({
      orderId,
      paymentId,
      signature,
      keySecret,
    });

    if (!isValid) {
      res.status(400).json({ verified: false, error: 'Invalid payment signature' });
      return;
    }

    try {
      const result = await activatePremiumFromVerification({
        userId,
        planId: plan.id,
        durationDays: plan.durationDays,
        paymentId,
        orderId,
      });

      if (result.status === 'conflict') {
        res.status(409).json({ verified: false, error: result.message ?? 'Payment verification conflict' });
        return;
      }

      res.status(200).json({
        verified: true,
        isPremium: true,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      handleDatabaseError(res, error, 'Verify payment database error');
    }
  });

  // 5. GET /premium-status -> accept ?userId=..., return { isPremium, planId, expiresAt }
  app.get('/premium-status', async (req: Request, res: Response) => {
    const userId = validateUserId(req.query.userId);
    if (!userId) {
      res.status(400).json({ error: 'Invalid or missing userId query parameter' });
      return;
    }

    try {
      const status = await getPremiumStatus(userId);
      res.status(200).json({
        isPremium: status.isPremium,
        planId: status.planId,
        expiresAt: status.expiresAt,
      });
    } catch (error) {
      handleDatabaseError(res, error, 'Get premium status database error');
    }
  });

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // JSON parse / internal error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const app = createApp();
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ChatMate Payment Backend listening on http://0.0.0.0:${PORT}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    closeDb()
      .catch((err) => console.error('Error closing database pool:', err))
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
