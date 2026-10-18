import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as puppeteer from 'puppeteer';

/** Tiempo máximo para cargar el HTML y para imprimir el PDF. */
const RENDER_TIMEOUT_MS = 15_000;
/** Páginas de Chromium a la vez (memoria acotada en generación masiva). */
const MAX_CONCURRENT_PAGES = 2;
/** Renders en espera y cuánto esperan como máximo (después, 503). */
const MAX_QUEUED = 50;
const QUEUE_TIMEOUT_MS = 30_000;
/** Un boletín no debería pasar de unas pocas páginas. */
const MAX_PAGES = 20;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * HTML -> PDF con un Chromium por proceso (se lanza al primer uso y se relanza
 * si se cae). Endurecido porque la plantilla es HTML ajeno:
 * - sin JavaScript y en modo sin conexión;
 * - toda petición se aborta salvo los data: (sin red, sin file://, sin
 *   redirecciones por <meta refresh>): el logo llega embebido;
 * - sin resolución DNS y con un proxy inexistente, también para loopback:
 *   ni dns-prefetch ni preconnect salen del proceso (hallazgo M4, fase 10a);
 * - un contexto de navegador aislado por render (sin caché compartida);
 * - tiempo máximo, como máximo 20 páginas y 10 MB; la página y el contexto
 *   siempre se cierran;
 * - cola acotada: con demasiados renders en espera responde 503.
 * En producción, además, el contenedor no debería tener salida a la red.
 */
@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRendererService.name);
  private browser: Promise<puppeteer.Browser> | null = null;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly config: ConfigService) {}

  async render(html: string): Promise<Buffer> {
    await this.acquire();
    let context: puppeteer.BrowserContext | undefined;
    try {
      const browser = await this.getBrowser();
      context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setOfflineMode(true);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.url().startsWith('data:')) {
          void request.continue();
        } else {
          void request.abort('blockedbyclient');
        }
      });
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: RENDER_TIMEOUT_MS,
      });
      const pdf = Buffer.from(
        await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          format: 'Letter',
          pageRanges: `1-${MAX_PAGES}`,
          timeout: RENDER_TIMEOUT_MS,
        }),
      );
      if (pdf.length > MAX_PDF_BYTES) {
        throw new UnprocessableEntityException(
          'El PDF generado es demasiado grande',
        );
      }
      return pdf;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `No se pudo generar el PDF: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('No se pudo generar el PDF');
    } finally {
      await context?.close().catch(() => undefined);
      this.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) await (await browser.catch(() => null))?.close();
  }

  private getBrowser(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      const noSandbox = this.config.get<boolean>('PDF_CHROMIUM_NO_SANDBOX');
      const launching = puppeteer.launch({
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--no-first-run',
          // Sin red aunque algo se salte la interceptación (M4).
          '--proxy-server=http://127.0.0.1:9',
          '--proxy-bypass-list=<-loopback>',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          ...(noSandbox ? ['--no-sandbox'] : []),
        ],
      });
      this.browser = launching;
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            if (this.browser === launching) this.browser = null;
          }),
        () => {
          if (this.browser === launching) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_PAGES) {
      this.active++;
      return;
    }
    if (this.waiting.length >= MAX_QUEUED) {
      throw new ServiceUnavailableException(
        'Hay demasiados PDF en proceso, intente de nuevo',
      );
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(turn);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(
          new ServiceUnavailableException(
            'Hay demasiados PDF en proceso, intente de nuevo',
          ),
        );
      }, QUEUE_TIMEOUT_MS);
      this.waiting.push(turn);
    });
  }

  /** Pasa el turno al siguiente en espera (el contador no baja) o libera. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
