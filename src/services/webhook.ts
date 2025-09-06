import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { createHash, createHmac } from 'crypto';
import { config } from '../config';
import { logger } from './logger';

export class WebhookService {
  private app: express.Application;
  private server: any;
  private messageHandler?: (msg: any) => void;
  private pollingHandler?: () => Promise<void>;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Parse JSON bodies
    this.app.use(bodyParser.json());

    // Add basic security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Telegram webhook endpoint
    this.app.post('/webhook', (req: Request, res: Response) => {
      try {
        // Verify webhook secret if configured
        if (config.telegram.webhookSecret) {
          const signature = req.headers['x-telegram-bot-api-secret-token'];
          if (signature !== config.telegram.webhookSecret) {
            logger.warn('Invalid webhook secret received', {
              component: 'webhook',
              clientIp: req.ip,
              userAgent: req.headers['user-agent']
            });
            return res.status(401).json({ error: 'Unauthorized' });
          }
        }

        // Process the update
        const update = req.body;
        if (update && this.messageHandler) {
          this.messageHandler(update);
        }

        res.status(200).json({ ok: true });
      } catch (error) {
        logger.error('Webhook processing error', error as Error, {
          component: 'webhook',
          clientIp: req.ip,
          userAgent: req.headers['user-agent']
        });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // External cron polling endpoint
    this.app.post('/poll', async (req: Request, res: Response) => {
      try {
        // Verify API key if configured
        if (config.cron.apiKey) {
          const authHeader = req.headers.authorization;
          const expectedAuth = `Bearer ${config.cron.apiKey}`;

          if (!authHeader || authHeader !== expectedAuth) {
            logger.warn('Invalid API key for polling endpoint', {
              component: 'webhook',
              endpoint: '/poll',
              clientIp: req.ip,
              userAgent: req.headers['user-agent']
            });
            return res.status(401).json({ error: 'Unauthorized' });
          }
        }

        // Check if polling handler is set
        if (!this.pollingHandler) {
          return res.status(503).json({ error: 'Polling service not available' });
        }

        const correlationId = logger.startOperation('external-cron-polling');
        logger.webhookOperation('🔄 External cron triggered polling cycle', {
          correlationId,
          clientIp: req.ip,
          userAgent: req.headers['user-agent']
        });

        // Run polling in background to avoid timeout
        this.pollingHandler().catch(error => {
          logger.endOperation(correlationId, false);
          logger.error('Error in external cron polling', error as Error, {
            correlationId,
            component: 'webhook'
          });
        });

        res.status(200).json({
          ok: true,
          message: 'Polling cycle started',
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        logger.error('Polling endpoint error', error as Error, {
          component: 'webhook',
          endpoint: '/poll',
          clientIp: req.ip
        });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Root endpoint
    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'telegram-github-stars',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv
      });
    });

    // Catch-all route for unhandled requests
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  setMessageHandler(handler: (msg: any) => void): void {
    this.messageHandler = handler;
  }

  setPollingHandler(handler: () => Promise<void>): void {
    this.pollingHandler = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(config.telegram.webhookPort, () => {
          logger.info('Webhook server started', {
            port: config.telegram.webhookPort,
            webhookUrl: config.telegram.webhookUrl,
            component: 'webhook'
          });
          resolve();
        });

        this.server.on('error', (error: Error) => {
          logger.error('Webhook server error', error, { component: 'webhook' });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((error?: Error) => {
          if (error) {
            logger.error('Error stopping webhook server', error, { component: 'webhook' });
            reject(error);
          } else {
            logger.info('Webhook server stopped', { component: 'webhook' });
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  getApp(): express.Application {
    return this.app;
  }

  isRunning(): boolean {
    return !!this.server && this.server.listening;
  }
}
