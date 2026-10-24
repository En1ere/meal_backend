import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
import type { OptionalConsentKind } from './legal-consent.contracts.js';
import { LegalConsentService } from './legal-consent.service.js';

const LEGAL_CONSENT = 'meal.legal-consent';
type Requirement = { kind: OptionalConsentKind; feature: string };
export const RequireLegalConsent = (kind: OptionalConsentKind, feature: string) =>
    SetMetadata(LEGAL_CONSENT, { kind, feature } satisfies Requirement);

@Injectable()
export class LegalConsentGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly consents: LegalConsentService,
    ) {}
    async canActivate(context: ExecutionContext) {
        const requirement = this.reflector.getAllAndOverride<Requirement>(LEGAL_CONSENT, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!requirement) return true;
        const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
        if (!request.principal) return false;
        await this.consents.assertFeatureAccess(request.principal.id, requirement.kind, requirement.feature);
        return true;
    }
}
