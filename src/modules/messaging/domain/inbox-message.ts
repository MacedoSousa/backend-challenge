import { InvariantViolationError } from '../../../shared/domain/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/**
 * Registro de mensagem consumida, deduplicado por (consumerName, messageId) no banco
 * e gravado na mesma transação SQL dos efeitos (ADR-10).
 */
export class InboxMessage {
  private constructor(private state: InboxMessageState) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage({
      ...props,
      receivedAt: new Date(props.receivedAt),
      processedAt: undefined,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get messageId() {
    return this.state.messageId;
  }
  get consumerName() {
    return this.state.consumerName;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get receivedAt() {
    return new Date(this.state.receivedAt);
  }
  get processedAt() {
    return this.state.processedAt && new Date(this.state.processedAt);
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  /** Mesmo messageId com payload diferente é anomalia do produtor (D-14). */
  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`mensagem ${this.state.messageId} já foi processada`);
    }
    this.state.processedAt = new Date(at);
  }
}
