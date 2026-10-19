import { MailMessage, MailService } from '../../src/modules/mail/mail.service';

/**
 * Correo en memoria para las e2e: guarda los mensajes para leer los enlaces
 * (verificación de email, recuperación) sin SMTP ni el log.
 */
export class FakeMailService implements Pick<MailService, 'send'> {
  readonly messages: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  /** Mensajes enviados a esa dirección (sin distinguir mayúsculas). */
  to(address: string): MailMessage[] {
    return this.messages.filter(
      (m) => m.to.toLowerCase() === address.toLowerCase(),
    );
  }

  /** Token del último enlace de verificación enviado a esa dirección. */
  verifyToken(address: string): string | null {
    for (const m of [...this.to(address)].reverse()) {
      const match = /verify-email#token=([a-f0-9]{96})/.exec(m.text);
      if (match) return match[1];
    }
    return null;
  }

  /** Espera a que llegue un correo (los envíos no se esperan en el servicio). */
  async waitFor(address: string, count = 1): Promise<MailMessage[]> {
    for (let i = 0; i < 50 && this.to(address).length < count; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.to(address);
  }
}
