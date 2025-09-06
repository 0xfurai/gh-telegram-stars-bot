import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { createHash, createHmac } from 'crypto';
import { config } from '../config';

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
    this.app.use('/', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

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
            console.warn('Invalid webhook secret received');
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
        console.error('Webhook processing error:', error);
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
            console.warn('Invalid API key for polling endpoint');
            return res.status(401).json({ error: 'Unauthorized' });
          }
        }

        // Check if polling handler is set
        if (!this.pollingHandler) {
          return res.status(503).json({ error: 'Polling service not available' });
        }

        console.log('🔄 External cron triggered polling cycle...');

        // Run polling in background to avoid timeout
        this.pollingHandler().catch(error => {
          console.error('Error in external cron polling:', error);
        });

        res.status(200).json({
          ok: true,
          message: 'Polling cycle started',
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error('Polling endpoint error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
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
          console.log(`Webhook server started on port ${config.telegram.webhookPort}`);
          console.log(`Webhook URL: ${config.telegram.webhookUrl}`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          console.error('Webhook server error:', error);
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
            console.error('Error stopping webhook server:', error);
            reject(error);
          } else {
            console.log('Webhook server stopped');
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
