import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Envío de correos con nodemailer. Sin SMTP_HOST (solo permitido fuera de
 * producción) el correo se escribe en el log para poder probar en desarrollo.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    this.from =
      config.get<string>('MAIL_FROM') || 'Aula360 <no-reply@aula360.local>';
    this.transporter = host
      ? createTransport({
          host,
          port: Number(config.get('SMTP_PORT') ?? 587),
          secure: Number(config.get('SMTP_PORT')) === 465,
          // En 587 exige STARTTLS: el enlace con el token nunca viaja en claro.
          requireTLS: Number(config.get('SMTP_PORT')) !== 465,
          auth: config.get<string>('SMTP_USER')
            ? {
                user: config.get<string>('SMTP_USER'),
                pass: config.get<string>('SMTP_PASS'),
              }
            : undefined,
        })
      : null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `[DEV] SMTP sin configurar. Correo para ${message.to} — ${message.subject}\n${message.text}`,
      );
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}
