import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

/**
 * Identidade do provedor que chama a API. Ponto de extensão para um IdP externo
 * (desenho alvo: Keycloak, client credentials por provedor — ver ADR-16).
 */
export interface ProviderIdentity {
  providerId: string;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export interface ProviderIdentityPort {
  /** Resolve a identidade a partir do token; `undefined` = não autenticado. */
  resolve(bearerToken: string | undefined): Promise<ProviderIdentity | undefined>;
}

/**
 * Guard global **no-op** (decisão documentada em ADR-16): autenticação vale 0 pontos
 * no desafio. Quando um IdP for integrado, este guard passa a exigir uma identidade
 * válida via ProviderIdentityPort para rotas não marcadas com @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    return this.isPublic(context) || this.authenticate(context);
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** No-op até a integração com o IdP: toda requisição é aceita. */
  private authenticate(_context: ExecutionContext): boolean {
    return true;
  }
}

@Module({ providers: [{ provide: APP_GUARD, useClass: AuthGuard }] })
export class AuthModule {}
