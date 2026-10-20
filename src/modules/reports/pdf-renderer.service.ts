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

/** Páginas de Chromium a la vez (memoria acotada en generación masiva). */
const MAX_CONCURRENT_PAGES = 2;
/** Renders en espera como máximo (después, 503). */
const MAX_QUEUED = 50;
/** Un boletín no debería pasar de unas pocas páginas. */
const MAX_PAGES = 20;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * Política que la plantilla no puede relajar (las CSP se suman): solo
 * imágenes y fuentes data: y estilos en línea (B1 de la fase 11e).
 */
export const RENDER_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`;

/**
 * Pone la CSP antes que todo el HTML de la plantilla (después del doctype,
 * para no pasar a modo quirks). El parser la ubica en el <head> que crea, y
 * ningún comentario ni etiqueta de la plantilla puede quedar antes.
 */
export function withContentSecurityPolicy(html: string): string {
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? doctype[0] + CSP_META + html.slice(doctype[0].length)
    : CSP_META + html;
}

class StepTimeoutError extends Error {}

/**
 * HTML -> PDF con un Chromium por proceso. Endurecido porque la plantilla es
 * HTML ajeno:
 * - sin JavaScript y en modo sin conexión; toda petición se aborta salvo los
 *   data: (sin red, sin file://, sin <meta refresh>); el logo va embebido;
 * - una CSP del servidor (default-src 'none') delante de la plantilla;
 * - sin resolución DNS y con un proxy inexistente, también para loopback
 *   (hallazgo M4 de la fase 10a);
 * - un contexto de navegador aislado por render; máximo 20 páginas y 10 MB;
 * - cola acotada: con demasiados renders en espera responde 503.
 *
 * Y se recupera solo (un Chromium colgado no debe exigir reiniciar el backend):
 * - cada paso con Chromium tiene tiempo máximo, también abrir y cerrar el
 *   contexto: un paso colgado nunca deja ocupado un cupo;
 * - ante un tiempo agotado o un error de Chromium, el navegador se mata
 *   (SIGKILL) y el siguiente render lanza uno nuevo; si el proceso muere solo
 *   ('disconnected'), también;
 * - se recicla cada cierto número de renders (la memoria de Chromium crece);
 * - los continue/abort de la interceptación nunca dejan promesas rechazadas
 *   sin manejar (tumbarían el proceso de Node).
 * En producción, además, el contenedor no debería tener salida a la red.
 */
@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRendererService.name);
  private browser: Promise<puppeteer.Browser> | null = null;
  private rendersOnBrowser = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /** Tiempos y reciclaje (protegidos para poder acortarlos en las pruebas). */
  protected stepTimeoutMs = 15_000;
  protected closeTimeoutMs = 5_000;
  protected launchTimeoutMs = 30_000;
  protected queueTimeoutMs = 30_000;
  protected maxRendersPerBrowser = 200;

  constructor(private readonly config: ConfigService) {}

  async render(html: string): Promise<Buffer> {
    await this.acquire();
    let context: puppeteer.BrowserContext | undefined;
    let browser: Promise<puppeteer.Browser> | null = null;
    let broken = false;
    try {
      browser = this.getBrowser();
      const instance = await this.step(browser, 'abrir Chromium');
      this.rendersOnBrowser++;
      context = await this.step(
        instance.createBrowserContext(),
        'crear el contexto',
      );
      const page = await this.step(context.newPage(), 'abrir la página');
      await this.step(page.setJavaScriptEnabled(false), 'configurar');
      await this.step(page.setOfflineMode(true), 'configurar');
      await this.step(page.setRequestInterception(true), 'configurar');
      page.on('request', (request) => {
        const handled = request.url().startsWith('data:')
          ? request.continue()
          : request.abort('blockedbyclient');
        handled.catch(() => undefined);
      });
      await this.step(
        page.setContent(withContentSecurityPolicy(html), {
          waitUntil: 'load',
          timeout: this.stepTimeoutMs,
        }),
        'cargar el HTML',
      );
      const pdf = Buffer.from(
        await this.step(
          page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            format: 'Letter',
            pageRanges: `1-${MAX_PAGES}`,
            timeout: this.stepTimeoutMs,
          }),
          'imprimir el PDF',
        ),
      );
      if (pdf.length > MAX_PDF_BYTES) {
        throw new UnprocessableEntityException(
          'El PDF generado es demasiado grande',
        );
      }
      return pdf;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      broken = true;
      this.logger.error(
        `No se pudo generar el PDF: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('No se pudo generar el PDF');
    } finally {
      if (context) {
        try {
          await this.step(
            context.close(),
            'cerrar el contexto',
            this.closeTimeoutMs,
          );
        } catch {
          broken = true;
        }
      }
      if (browser && broken) {
        void this.restart(browser, 'falló o no respondió');
      } else if (
        browser &&
        this.rendersOnBrowser >= this.maxRendersPerBrowser &&
        this.active === 1
      ) {
        void this.restart(browser, 'reciclaje', false);
      }
      this.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser)
      await this.restart(this.browser, 'apagado del backend', false);
  }

  private getBrowser(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      const noSandbox = this.config.get<boolean>('PDF_CHROMIUM_NO_SANDBOX');
      const launching = puppeteer.launch({
        headless: true,
        timeout: this.launchTimeoutMs,
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
      this.rendersOnBrowser = 0;
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            if (this.browser === launching) {
              this.logger.warn('Chromium se cerró: se lanzará otro');
              this.browser = null;
            }
          }),
        () => {
          if (this.browser === launching) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  /**
   * Descarta este navegador (el siguiente render lanza otro) y lo cierra en
   * segundo plano; si no cierra a tiempo, o si falló, se mata el proceso.
   */
  private restart(
    target: Promise<puppeteer.Browser>,
    reason: string,
    kill = true,
  ): Promise<void> {
    if (this.browser === target) this.browser = null;
    this.logger.warn(`Reiniciando Chromium (${reason})`);
    return target
      .then(async (browser) => {
        const process = browser.process();
        if (kill) {
          process?.kill('SIGKILL');
          return;
        }
        try {
          await this.step(
            browser.close(),
            'cerrar Chromium',
            this.closeTimeoutMs,
          );
        } catch {
          process?.kill('SIGKILL');
        }
      })
      .catch(() => undefined);
  }

  /** Espera la promesa como máximo ms; si no, StepTimeoutError. */
  private step<T>(
    promise: Promise<T>,
    label: string,
    ms = this.stepTimeoutMs,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StepTimeoutError(`Chromium no respondió al ${label}`)),
        ms,
      );
    });
    // Si gana el tiempo máximo, un rechazo tardío de la promesa no queda suelto.
    promise.catch(() => undefined);
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
      }, this.queueTimeoutMs);
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
